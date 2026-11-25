# AI Video Editor — project instructions

A local-first AI video editing agent. It analyses footage, plans cuts, builds a
deterministic FilmCraft timeline, and exports a finished 1080p MP4 plus an
editable project and a human-readable editing report.

Read `PRD.md`, `ARCHITECTURE.md`, `TDD.md`, and `IMPLEMENTATION_PLAN.md` before
changing behaviour. They describe verified constraints, not aspirations.

---

## The five rules

These exist because each one was learned from a real failure on this machine.

### 1. Never modify source footage

`workspace/inbox/` is read-only. Every source is hashed at ingest and re-hashed
before export. Any drift aborts the job. Never `mv`, never overwrite, never
"clean up" an input file.

### 2. FilmCraft command params are silently permissive

Unknown keys are dropped; some wrong types fall back to defaults. A `null`
result means **the command ran**, not that it worked.

```js
// WRONG — silently places the clip at 0
{ track: "V1", time: { seconds: 6 } }

// RIGHT — `seconds` is a sibling of `track`
{ track: "V1", seconds: 6 }
```

Every mutation must be followed by a read-back assertion (`sequence_inspect`).
See `services/editing-orchestrator/src/filmcraft/assert.mjs`.

### 3. Integer ticks, never floats

`254_016_000_000` ticks per second. All tick math is `BigInt` in JS and `int` in
Python. Ten hours of ticks exceeds `Number.MAX_SAFE_INTEGER`, so `Number` is
not merely imprecise — it is wrong.

### 4. Never hardcode a command id or preset from memory

Query `command_list` and `export.presets.list`. The 1080p H.264 preset on this
machine is `"High Quality 1080p HD"`; `"H.264"` does not exist.

### 5. The LLM plans, code executes

The model returns `editing-plan.json` matching
`schemas/editing-plan.schema.json`. It is validated three ways (schema, reality,
sanity) before a single FilmCraft command is emitted. The model never emits a
raw timeline command.

---

## Layout

```
apps/cli/                        job lifecycle CLI (node)
services/editing-orchestrator/   plan → timeline ops → FilmCraft (TypeScript/ESM)
services/video-intelligence/     probe, transcribe, VAD, scenes, silence (Python)
schemas/                         JSON Schema contracts
presets/                         editorial profiles + lexicons
.opencode/agents/                video-editor, media-analyst, timeline-builder
.opencode/skills/                filmcraft, video-intelligence
workspace/                       per-job artefacts (never source)
tests/                           node:test unit + contract tests
scripts/                         verify-env, smoke-test
```

## Environment

| Thing | Value |
|---|---|
| FilmCraft | 0.17.1 (`/usr/bin/filmcraft`, `/usr/bin/filmcraft-cli`) |
| Python | `.venv/bin/python` (system Python is PEP 668 externally-managed) |
| Node | 18.19.1, ESM only |
| Hardware | 12 cores, 14 GB RAM, **no GPU** |
| Whisper | CPU via CTranslate2, `int8`, models in `workspace/models/` |
| VAD | Silero ONNX bundled in `faster_whisper.vad` — **do not install torch** |

## Commands

```sh
npm run verify        # capability probe: binaries, python, commands, presets
npm run smoke         # end-to-end synthetic build → MP4 (proves the pipeline)
npm test              # unit + contract tests
npm run edit -- --input workspace/inbox/<job>
```

Bridge mode (live GUI on screen — requires 64-char hex `FILMCRAFT_CONTROL_TOKEN`):

```sh
# Terminal 1: start FilmCraft GUI with control port 7991 (prints token + saves workspace/logs/bridge.json)
./scripts/bridge-gui.sh

# Terminal 2: export the printed token and run edit against the live window
export FILMCRAFT_CONTROL_TOKEN=<64-hex-token>
npm run edit -- --input "raw-video/Video 1.mp4" --preset tutorial-id --job video-1 --cut-kinds silence,dead_air --no-burn-captions --bridge 127.0.0.1:7991 --resume
```

Python analysis:

```sh
.venv/bin/python -m vidintel probe   <files> --out media.json --job <id>
.venv/bin/python -m vidintel pipeline <files> --out-dir <dir> --job <id>
```

## Working style

- Prefer a working end-to-end path over a new abstraction.
- When a FilmCraft capability is unverified, probe it and record the result
  before building on it.
- Add a test whenever a bug is found; this codebase's tests encode its traps.
- Keep the analyser (Python) and the executor (TypeScript) separate: Python
  never touches a timeline, TypeScript never decodes media.
