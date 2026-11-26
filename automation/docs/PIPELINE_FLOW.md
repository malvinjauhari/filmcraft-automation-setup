# Pipeline Flow & Data Contracts

Diagram alur end-to-end `ai-video-automation`:

```
Input (--input URL atau path lokal)
   │
   ├──[Jika URL http/https]──▶ services/media-downloader (libreget-cli)
   │                              ├── libreget info <URL>    (judul, chapter)
   │                              └── libreget download <URL> -q 1080 -o workspace/raw-video
   │                              └── output: file video lokal + download-meta.json
   ▼
[1/6] Ingest & SHA-256 Hash
   │   └── .venv/bin/python -m vidintel probe -> workspace/jobs/<id>/media.json
   ▼
[2/6] Video Intelligence (Python)
   │   └── .venv/bin/python -m vidintel pipeline
   │       ├── ffmpeg -> WAV 16 kHz mono PCM
   │       ├── faster-whisper (int8, CPU) -> word timestamps -> transcript.json
   │       ├── faster_whisper.vad (Silero ONNX) -> speech spans & silence
   │       └── PySceneDetect -> scene cuts -> analysis.json
   ▼
[3/6] Plan & Validate (TypeScript/ESM)
   │   ├── proposePlan(analysis, preset) -> editing-plan.json
   │   └── validatePlan(plan, media)     -> 3-layer check (schema, reality, sanity)
   ▼
[4/6] Compile & Subtitles
   │   ├── formatSrt()   -> workspace/jobs/<id>/subtitles.srt
   │   └── compilePlan() -> workspace/jobs/<id>/timeline-ops.json
   ▼
[5/6] FilmCraft Build & Export (MCP / CLI / Bridge GUI)
   │   ├── Re-hash source SHA-256 (abort on drift)
   │   ├── TimelineBuilder -> FilmCraft commands + sequence.inspect read-back
   │   ├── Project       -> workspace/jobs/<id>/project.fcproj
   │   └── Export 1080p  -> workspace/exports/<id>.mp4
   ▼
[6/6] Post-Export QC & Report
       ├── qcExport()    -> ffprobe + loudnorm check
       └── writeReport() -> workspace/jobs/<id>/report.md
```

---

## Kontrak JSON (`schemas/`)

| File Schema | Diproduksi Oleh | Dikonsumsi Oleh |
|---|---|---|
| `schemas/media.schema.json` | `vidintel probe` | `validate.mjs`, `compile.mjs`, `qc/check.mjs` |
| `schemas/transcript.schema.json` | `vidintel pipeline` | `propose.mjs`, `report/write.mjs` |
| `schemas/analysis.schema.json` | `vidintel pipeline` | `propose.mjs` |
| `schemas/editing-plan.schema.json` | `propose.mjs` / LLM | `validate.mjs`, `compile.mjs` |
| `schemas/timeline-ops.schema.json` | `compile.mjs` | `TimelineBuilder` (`timeline/build.mjs`) |
