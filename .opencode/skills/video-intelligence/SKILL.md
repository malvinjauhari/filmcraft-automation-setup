---
name: Video Intelligence
description: Analyse video for editing — transcribe speech with word timestamps, detect voice activity, find silence and filler words, detect scene cuts, and emit cut candidates. Use when analysing footage, generating transcripts/subtitles, finding dead air or "eee/emm" fillers, measuring speech vs silence, or producing the analysis.json that the editing plan is built from. Triggers on "transcribe this video", "find silences", "detect fillers", "generate subtitles from footage", "analyse this recording".
---

# Video Intelligence — media analysis

Deterministic, model-free observation of media. This layer answers *what is in
the footage*; it never decides *what to cut* and never touches a timeline.

## Environment

Use the project venv — system Python is PEP 668 externally-managed:

```sh
.venv/bin/python
```

Installed and verified: `faster-whisper 1.2.1`, `ctranslate2 4.9.1`,
`scenedetect 0.7.3`, `pydantic 2.x`, `numpy 2.x`, `jsonschema`.
**No torch, no CUDA.** This machine is CPU-only (12 cores, 14 GB).

## Time model

FilmCraft ticks: **254,016,000,000 per second**.

```python
TICKS_PER_SECOND = 254_016_000_000
def to_ticks(seconds: float) -> int:  return round(seconds * TICKS_PER_SECOND)
def to_seconds(ticks: int) -> float:  return ticks / TICKS_PER_SECOND
```

JSON carries ticks as **strings** to survive the JS float boundary. Python may
use `int` internally.

## Step 1 — probe

```sh
ffprobe -v error -print_format json -show_format -show_streams INPUT
```

Record `duration`, `r_frame_rate` (as a rational — `30000/1001` is 29.97, not
30), width, height, sample rate, channels. Do not use FilmCraft's probe here;
this layer must work without FilmCraft running.

## Step 2 — extract audio

```sh
ffmpeg -y -i INPUT -vn -ac 1 -ar 16000 -c:a pcm_s16le out.wav
```

Always transcribe the WAV, never the container. 16 kHz mono is what Whisper
wants; resampling twice loses quality and speed.

## Step 3 — transcribe

```python
from faster_whisper import WhisperModel

model = WhisperModel(
    "base",                      # tiny | base | small  (small = most accurate here)
    device="cpu",
    compute_type="int8",         # CPU speed; fp16 is useless without CUDA
    download_root=str(MODELS_DIR),
)
segments, info = model.transcribe(
    wav,
    language="id",               # or "auto"
    word_timestamps=True,        # REQUIRED for filler cuts and tight subtitles
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 500},
    condition_on_previous_text=False,   # prevents repetition loops
    beam_size=5,
)
```

Models download on first use into `workspace/models/`:
`base` ≈ 145 MB, `small` ≈ 480 MB. There is no pre-installed model — the first
run is slower.

**Discard hallucinations:** segments with `no_speech_prob > 0.6` or
`avg_logprob < -1.0` are Whisper inventing text over silence. Drop them.

## Step 4 — voice activity (no torch)

Silero VAD ships as an ONNX asset **inside** `faster_whisper`:

```python
from faster_whisper.vad import VadOptions, get_speech_timestamps
spans = get_speech_timestamps(audio_f32_16k, VadOptions(
    threshold=0.5,
    min_silence_duration_ms=500,
    speech_pad_ms=200,
))
```

Do not `pip install silero-vad` — it drags in a ~539 MB torch wheel that is
unused here. The ONNX path gives identical results on CPU.

## Step 5 — silence and fillers

Silences are the gaps between speech spans, longer than the threshold
(default 500 ms), classified:

| Class | Meaning |
|---|---|
| `leading` | before the first speech span |
| `internal` | between two spans |
| `trailing` | after the last speech span |
| `pause` | internal but shorter than 2× threshold |

Fillers match a lexicon (`presets/*.json`), Indonesian and English:

```python
FILLERS_ID = {"eee","eh","emm","em","hmm","hm","anu","gitu","kayak","kayaknya","ya kan","gimana"}
FILLERS_EN = {"um","uh","erm","like","you know","so yeah"}
```

## Step 6 — scenes

```python
from scenedetect import open_video, SceneManager
from scenedetect import ContentDetector

video = open_video(path)
sm = SceneManager(); sm.add_detector(ContentDetector(threshold=27.0))
sm.detect_scenes(video)
scenes = sm.get_scene_list()      # [(start_timecode, end_timecode), …]
```

Scene boundaries stop us cutting across a visual change (jarring mid-scroll) and
seed chapter markers.

## Guards — these prevent unusable output

1. **Snap to word edges.** A cut that lands mid-word sounds like a glitch.
2. **Max 35% removed per 30 s window.** More means the detector is wrong.
3. **Flag cuts near a scene boundary** (`nearSceneCut`) so the plan can skip them.
4. **Never cut the first 300 ms or last 300 ms** of a take.

## Outputs

Write to `workspace/projects/<jobId>/`:

- `transcript.json` → `schemas/transcript.schema.json`
- `analysis.json` → `schemas/analysis.schema.json`

Validate before returning:

```sh
.venv/bin/python -c "
import json, jsonschema
jsonschema.validate(json.load(open('analysis.json')),
                    json.load(open('schemas/analysis.schema.json')))
print('valid')"
```

## Quick reference

| Need | Call |
|---|---|
| duration / fps | `ffprobe -show_format -show_streams` |
| clean audio | `ffmpeg -vn -ac 1 -ar 16000` |
| words + times | `model.transcribe(..., word_timestamps=True)` |
| speech spans | `faster_whisper.vad.get_speech_timestamps` |
| shot cuts | `scenedetect` `ContentDetector` |
| validate output | `jsonschema.validate` |
