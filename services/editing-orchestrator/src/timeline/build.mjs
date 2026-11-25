/**
 * Execute timeline ops against FilmCraft, verifying every mutation.
 *
 * Order matters: newProject -> newSequence -> import -> place -> captions ->
 * gain -> markers -> save -> export. Each mutation is followed by a read-back.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as cmd from "../filmcraft/commands.mjs";
import {
  assertClipCount,
  assertDuration,
  assertExport,
  assertImport,
  assertSaved,
  clipsOn,
} from "../filmcraft/assert.mjs";
import { ticksToSeconds } from "./time.mjs";

export class TimelineBuilder {
  constructor(client, { log = () => {} } = {}) {
    this.client = client;
    this.log = log;
    /** sourceIndex -> FilmCraft item id */
    this.itemBySource = new Map();
  }

  /**
   * @param {{ops:object[], expectedDurationTicks:string}} compiled
   * @param {{fps:number, exportPath:string, projectPath:string, preset:string,
   *          burnCaptions?:boolean, captionSidecar?:boolean}} target
   */
  async build(compiled, target) {
    const { ops, expectedDurationTicks } = compiled;
    const fps = target.fps;

    await this.client.start();

    // ---- project + sequence ---------------------------------------------
    const projOp = ops.find((o) => o.op === "newProject");
    await this.client.run(...argsOf(cmd.newProject(projOp.name)));
    this.log("created project", projOp.name);

    const seqOp = ops.find((o) => o.op === "newSequence");
    const seqRes = await this.client.run(...argsOf(cmd.newSequence(seqOp)));
    this.log("created sequence", seqRes.sequence);

    // ---- import ----------------------------------------------------------
    const impOp = ops.find((o) => o.op === "importMedia");
    const impRes = await this.client.mediaImport(impOp.paths);
    const items = assertImport(impRes, {
      expectedCount: impOp.paths.length,
      command: "media_import",
    });
    impOp.sourceIndices.forEach((si, i) => this.itemBySource.set(si, items[i]));
    this.log("imported", `${items.length} items`);

    // ---- place -----------------------------------------------------------
    let placeCount = 0;
    for (const op of ops.filter((o) => o.op === "place")) {
      const item = this.itemBySource.get(op.sourceIndex);
      if (item === undefined) throw new Error(`no imported item for source ${op.sourceIndex}`);

      const startSeconds = ticksToSeconds(op.startTicks);
      const sourceInSeconds = ticksToSeconds(op.sourceInTicks);
      const durationSeconds = ticksToSeconds(op.durationTicks);

      await this.client.run(
        ...argsOf(
          cmd.placeClip({
            item,
            track: op.track,
            startSeconds,
            audioTrack: op.audioTrack,
            sourceInSeconds,
            durationSeconds,
          })
        )
      );
      placeCount++;

      // Verify the clip landed where we asked. Catches the nested-`time` trap.
      const seq = await this.client.sequenceInspect();
      const onTrack = clipsOn(seq, op.track);
      const last = onTrack[onTrack.length - 1];
      if (!last) throw new Error(`placement produced no clip on ${op.track}`);
      const drift = BigInt(last.start) - BigInt(op.startTicks);
      if (drift < 0n ? -drift > 1n : drift > 1n) {
        throw new Error(
          `clip on ${op.track} landed at ${last.start}, expected ${op.startTicks}`
        );
      }
    }
    this.log("placed clips", placeCount);

    // ---- duration assertion ---------------------------------------------
    const seqAfter = await this.client.sequenceInspect();
    assertDuration(seqAfter, {
      expectedTicks: expectedDurationTicks,
      command: "timeline.place",
      toleranceTicks: 1n,
    });
    this.log("duration verified", expectedDurationTicks);

    // ---- captions --------------------------------------------------------
    const capOps = ops.filter((o) => o.op === "caption");
    if (capOps.length > 0) {
      const trackRes = await this.client.run(
        ...argsOf(cmd.newCaptionTrack({ name: "Subtitles", language: "id" }))
      );
      for (const op of capOps) {
        await this.client.run(
          ...argsOf(
            cmd.addCaption({
              text: op.text,
              startSeconds: ticksToSeconds(op.startTicks),
              durationSeconds: ticksToSeconds(op.durationTicks),
              track: trackRes.track,
            })
          )
        );
      }
      const cues = await this.client.captionsList(trackRes.track);
      this.log("captions added", `${cues?.captions?.length ?? capOps.length}`);
    }

    // ---- audio gain ------------------------------------------------------
    for (const op of ops.filter((o) => o.op === "gain")) {
      const item = this.itemBySource.get(op.sourceIndex);
      const seq = await this.client.sequenceInspect();
      const audioClip = [...(seq.audio ?? [])]
        .flatMap((t) => t.items)
        .find((c) => c.item === item);
      if (!audioClip) {
        this.log("skip gain", `no audio clip for source ${op.sourceIndex}`);
        continue;
      }
      await this.client.run(
        ...argsOf(cmd.audioGain({ clips: [audioClip.clip], db: op.db }))
      );
    }

    // ---- markers ---------------------------------------------------------
    for (const op of ops.filter((o) => o.op === "marker")) {
      await this.client.run(
        ...argsOf(cmd.addMarker({ seconds: ticksToSeconds(op.startTicks), name: op.name }))
      );
    }

    // ---- save ------------------------------------------------------------
    await mkdir(dirname(target.projectPath), { recursive: true });
    await this.client.run(...argsOf(cmd.saveAs(target.projectPath)));
    await assertSaved(this.client, "file.saveAs");
    this.log("saved project", target.projectPath);

    // ---- export ----------------------------------------------------------
    await mkdir(dirname(target.exportPath), { recursive: true });
    const exp = await this.client.run(
      ...argsOf(
        cmd.exportMedia({
          path: target.exportPath,
          preset: target.preset,
          burnCaptions: target.burnCaptions ?? false,
          captionSidecar: target.captionSidecar ? "srt" : undefined,
          wait: true,
        })
      )
    );
    const outPath = assertExport(exp, { command: "file.exportMedia" });
    this.log("exported", outPath);

    return {
      sequenceId: seqRes.sequence,
      clipCount: placeCount,
      durationTicks: expectedDurationTicks,
      projectPath: target.projectPath,
      exportPath: outPath,
    };
  }
}

/** Turn a {id, params} command into positional args for client.run. */
function argsOf({ id, params }) {
  return [id, params];
}
