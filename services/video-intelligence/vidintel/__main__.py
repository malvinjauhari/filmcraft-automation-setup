"""Video Intelligence CLI.

Subcommands:
  probe     files -> media.json
  transcribe wav|media -> transcript.json
  analyse   media.json -> analysis.json (VAD + silence + fillers + scenes + candidates)
  pipeline  files -> media.json + transcript.json + analysis.json in one go

Every command writes JSON to disk and a short summary to stderr, so it composes
with the TypeScript orchestrator over a simple file contract.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from . import audio, probe, scenes as scenes_mod, silence, transcribe as tr, vad
from .log import Log
from .timeutil import fmt_seconds, to_seconds


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_probe(args) -> int:
    log = Log("probe")
    manifest = probe.build_manifest(args.files, args.job, hash_file=not args.no_hash)
    _write(Path(args.out), manifest)
    for s in manifest["sources"]:
        v = s.get("video", {})
        log.done(
            f"[{s['index']}] {Path(s['path']).name}",
            duration=fmt_seconds(s["durationTicks"]),
            size=f"{v.get('width')}x{v.get('height')}@{v.get('fps')}" if v else s["kind"],
        )
    log.done("wrote media.json", path=args.out, sources=len(manifest["sources"]))
    return 0


def cmd_transcribe(args) -> int:
    log = Log("transcribe")
    model = tr.load_model(args.model, model_dir=Path(args.model_dir) if args.model_dir else None)
    result = tr.transcribe(
        args.input,
        model_size=args.model,
        language=args.language,
        model=model,
        log=log,
    )
    result.update({"version": "1.0", "jobId": args.job, "sourceIndex": args.source_index})
    _write(Path(args.out), result)
    log.done(
        "transcribed",
        words=len(result["words"]),
        segments=len(result["segments"]),
        language=result["language"],
    )
    return 0


def cmd_analyse(args) -> int:
    log = Log("analyse")
    manifest = json.loads(Path(args.media).read_text())
    job_dir = Path(args.media).parent

    transcripts = {}
    for s in manifest["sources"]:
        tp = Path(args.transcript_dir) / f"transcript.{s['index']}.json" if args.transcript_dir else job_dir / f"transcript.{s['index']}.json"
        if tp.exists():
            transcripts[s["index"]] = json.loads(tp.read_text())
        elif args.transcript:
            transcripts[s["index"]] = json.loads(Path(args.transcript).read_text())
        else:
            log.warn("no transcript for source; using VAD only", source=s["index"])

    analyses = []
    with tempfile.TemporaryDirectory() as td:
        for s in manifest["sources"]:
            idx = s["index"]
            dur = s["durationSeconds"]
            log.info("analysing source", index=idx, duration=fmt_seconds(s["durationTicks"]))

            # speech spans from VAD on extracted audio
            wav = audio.extract_wav(s["path"], Path(td) / f"a{idx}.wav")
            spans = vad.merge_spans(
                vad.speech_spans(wav, min_silence_ms=int(args.min_silence * 1000))
            )
            log.info("speech spans", source=idx, count=len(spans))

            sc = scenes_mod.detect_scenes(s["path"], threshold=args.scene_threshold, log=log)

            tr_data = transcripts.get(idx, {"words": []})
            words = tr_data.get("words", [])
            sil = silence.find_silences(spans, dur, min_silence_seconds=args.min_silence)
            fil = silence.find_fillers(words)
            cands = silence.build_candidates(
                silences=sil,
                fillers=fil,
                words=words,
                scenes=sc,
                duration_seconds=dur,
                min_silence_seconds=args.min_silence,
            )

            speech_ticks = sum(int(sp["endTicks"]) - int(sp["startTicks"]) for sp in spans)
            cand_ticks = sum(int(c["endTicks"]) - int(c["startTicks"]) for c in cands)
            total_ticks = int(s["durationTicks"])

            analyses.append(
                {
                    "version": "1.0",
                    "jobId": manifest["jobId"],
                    "sourceIndex": idx,
                    "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
                    "speech": spans,
                    "silences": sil,
                    "fillers": fil,
                    "scenes": sc,
                    "candidates": cands,
                    "stats": {
                        "speechTicks": str(speech_ticks),
                        "silenceTicks": str(total_ticks - speech_ticks),
                        "candidateCount": len(cands),
                        "candidateTicks": str(cand_ticks),
                    },
                }
            )
            log.done(
                "source analysed",
                index=idx,
                candidates=len(cands),
                proposed=fmt_seconds(cand_ticks),
                speech_pct=round(100 * speech_ticks / total_ticks, 1) if total_ticks else 0,
            )

    out = analyses[0] if len(analyses) == 1 else {
        "version": "1.0", "jobId": manifest["jobId"], "sources": analyses
    }
    _write(Path(args.out), out)
    log.done("wrote analysis", path=args.out)
    return 0


def cmd_pipeline(args) -> int:
    """Files in, all three artefacts out."""
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log = Log("pipeline", path=out_dir / "logs" / "analysis.log")

    log.info("probing", files=len(args.files))
    manifest = probe.build_manifest(args.files, args.job, hash_file=not args.no_hash)
    _write(out_dir / "media.json", manifest)

    model = tr.load_model(args.model, model_dir=Path(args.model_dir) if args.model_dir else None)

    with tempfile.TemporaryDirectory() as td:
        all_analysis = []
        for s in manifest["sources"]:
            idx = s["index"]
            log.info("processing", index=idx, name=Path(s["path"]).name)
            wav = audio.extract_wav(s["path"], Path(td) / f"a{idx}.wav")

            t = tr.transcribe(wav, model_size=args.model, language=args.language, model=model, log=log)
            t.update({"version": "1.0", "jobId": args.job, "sourceIndex": idx})
            _write(out_dir / f"transcript.{idx}.json", t)

            spans = vad.merge_spans(vad.speech_spans(wav, min_silence_ms=int(args.min_silence * 1000)))
            sc = scenes_mod.detect_scenes(s["path"], threshold=args.scene_threshold, log=log)
            sil = silence.find_silences(spans, s["durationSeconds"], min_silence_seconds=args.min_silence)
            fil = silence.find_fillers(t["words"])
            cands = silence.build_candidates(
                silences=sil, fillers=fil, words=t["words"], scenes=sc,
                duration_seconds=s["durationSeconds"], min_silence_seconds=args.min_silence,
            )

            speech_ticks = sum(int(x["endTicks"]) - int(x["startTicks"]) for x in spans)
            cand_ticks = sum(int(c["endTicks"]) - int(c["startTicks"]) for c in cands)
            total_ticks = int(s["durationTicks"])

            all_analysis.append({
                "version": "1.0", "jobId": args.job, "sourceIndex": idx,
                "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
                "speech": spans, "silences": sil, "fillers": fil, "scenes": sc, "candidates": cands,
                "stats": {
                    "speechTicks": str(speech_ticks),
                    "silenceTicks": str(total_ticks - speech_ticks),
                    "candidateCount": len(cands),
                    "candidateTicks": str(cand_ticks),
                },
            })
            log.done("done", index=idx, words=len(t["words"]), candidates=len(cands),
                     proposed=fmt_seconds(cand_ticks))

        out = all_analysis[0] if len(all_analysis) == 1 else {
            "version": "1.0", "jobId": args.job, "sources": all_analysis
        }
        _write(out_dir / "analysis.json", out)

    log.done("pipeline complete", out_dir=str(out_dir))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="vidintel", description="Video Intelligence — media analysis")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="probe media into media.json")
    p.add_argument("files", nargs="+")
    p.add_argument("--job", default="job")
    p.add_argument("--out", required=True)
    p.add_argument("--no-hash", action="store_true", help="skip sha256 (faster on huge files)")
    p.set_defaults(fn=cmd_probe)

    t = sub.add_parser("transcribe", help="transcribe a wav/video")
    t.add_argument("input")
    t.add_argument("--out", required=True)
    t.add_argument("--job", default="job")
    t.add_argument("--source-index", type=int, default=0)
    t.add_argument("--model", default="base", choices=["tiny", "base", "small", "medium"])
    t.add_argument("--language", default="id")
    t.add_argument("--model-dir")
    t.set_defaults(fn=cmd_transcribe)

    a = sub.add_parser("analyse", help="build analysis.json from media + transcript")
    a.add_argument("--media", required=True)
    a.add_argument("--transcript")
    a.add_argument("--transcript-dir")
    a.add_argument("--out", required=True)
    a.add_argument("--min-silence", type=float, default=0.5)
    a.add_argument("--scene-threshold", type=float, default=27.0)
    a.set_defaults(fn=cmd_analyse)

    pl = sub.add_parser("pipeline", help="probe + transcribe + analyse in one run")
    pl.add_argument("files", nargs="+")
    pl.add_argument("--job", default="job")
    pl.add_argument("--out-dir", required=True)
    pl.add_argument("--model", default="base", choices=["tiny", "base", "small", "medium"])
    pl.add_argument("--language", default="id")
    pl.add_argument("--model-dir")
    pl.add_argument("--min-silence", type=float, default=0.5)
    pl.add_argument("--scene-threshold", type=float, default=27.0)
    pl.add_argument("--no-hash", action="store_true")
    pl.set_defaults(fn=cmd_pipeline)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
