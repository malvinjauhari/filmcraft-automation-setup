/**
 * Human-readable and machine-readable editing report writer.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ticksToSeconds } from "../timeline/time.mjs";

function fmtSec(ticks) {
  return `${ticksToSeconds(ticks).toFixed(2)}s`;
}

/**
 * Build structured editing report object.
 */
export function buildReport({
  jobId,
  presetName = "default",
  media,
  plan,
  compiled,
  qc = null,
}) {
  const originalTicks = media.sources.reduce(
    (acc, s) => acc + BigInt(s.durationTicks),
    0n
  );
  const finalTicks = BigInt(compiled.expectedDurationTicks);
  const removedTicks = originalTicks > finalTicks ? originalTicks - finalTicks : 0n;
  const savedPct =
    originalTicks > 0n
      ? Number(((Number(removedTicks) / Number(originalTicks)) * 100).toFixed(1))
      : 0;

  const byKind = {};
  for (const c of plan.cuts ?? []) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }

  return {
    version: "1.0",
    jobId,
    generatedAt: new Date().toISOString(),
    preset: presetName,
    summary: {
      sourceCount: media.sources.length,
      originalDurationSeconds: Number(ticksToSeconds(originalTicks).toFixed(3)),
      finalDurationSeconds: Number(ticksToSeconds(finalTicks).toFixed(3)),
      removedSeconds: Number(ticksToSeconds(removedTicks).toFixed(3)),
      savedPercent: savedPct,
      cutCount: (plan.cuts ?? []).length,
      subtitleCount: (plan.subtitles ?? []).length,
      cutsByKind: byKind,
    },
    cuts: (plan.cuts ?? []).map((c) => {
      const dur = BigInt(c.endTicks) - BigInt(c.startTicks);
      return {
        id: c.id,
        sourceIndex: c.sourceIndex,
        startSeconds: Number(ticksToSeconds(c.startTicks).toFixed(3)),
        endSeconds: Number(ticksToSeconds(c.endTicks).toFixed(3)),
        durationSeconds: Number(ticksToSeconds(dur).toFixed(3)),
        kind: c.kind,
        reason: c.reason,
        confidence: c.confidence,
      };
    }),
    qc,
  };
}

/** Format report as Markdown. */
export function formatReportMarkdown(report) {
  const s = report.summary;
  const lines = [
    `# Editing Report — ${report.jobId}`,
    ``,
    `- **Preset:** ${report.preset}`,
    `- **Generated:** ${report.generatedAt}`,
    `- **Sources:** ${s.sourceCount}`,
    `- **Original duration:** ${s.originalDurationSeconds.toFixed(2)}s`,
    `- **Final duration:** ${s.finalDurationSeconds.toFixed(2)}s`,
    `- **Removed:** ${s.removedSeconds.toFixed(2)}s (${s.savedPercent}%)`,
    `- **Cuts:** ${s.cutCount} · **Subtitles:** ${s.subtitleCount}`,
    ``,
    `## Cuts`,
    ``,
  ];

  if (report.cuts.length === 0) {
    lines.push(`_No cuts applied._`, ``);
  } else {
    lines.push(
      `| ID | Source | Start | End | Duration | Kind | Confidence | Reason |`,
      `|---|---|---|---|---|---|---|---|`
    );
    for (const c of report.cuts) {
      lines.push(
        `| ${c.id} | ${c.sourceIndex} | ${c.startSeconds.toFixed(2)}s | ${c.endSeconds.toFixed(2)}s | ${c.durationSeconds.toFixed(2)}s | ${c.kind} | ${c.confidence.toFixed(2)} | ${c.reason.replace(/\|/g, "\\|")} |`
      );
    }
    lines.push(``);
  }

  if (report.qc) {
    lines.push(`## QC`, ``);
    lines.push(`- **Passed:** ${report.qc.passed ? "Yes" : "No"}`);
    for (const chk of report.qc.checks ?? []) {
      lines.push(`- **${chk.name}:** ${chk.ok ? "OK" : "FAIL"}`);
    }
    for (const w of report.qc.warnings ?? []) {
      lines.push(`- **Warning:** ${w}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

/** Write editing-report.json and editing-report.md to outDir. */
export async function writeReport(outDir, report) {
  await writeFile(
    join(outDir, "editing-report.json"),
    JSON.stringify(report, null, 2),
    "utf8"
  );
  await writeFile(
    join(outDir, "editing-report.md"),
    formatReportMarkdown(report),
    "utf8"
  );
}
