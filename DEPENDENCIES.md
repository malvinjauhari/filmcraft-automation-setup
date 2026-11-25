# Dependencies — runtime, build, and Python
# Generated and verified 2026-11-26 on Linux Mint 22.3

# ---- system binaries (hard requirements) --------------------------------
# filmcraft          0.17.1   native Rust video editor (engine + GUI)
# filmcraft-cli      0.17.1   CLI + MCP server (17 tools, 716 commands)
# ffmpeg             6.1.1    decode, extract audio, QC probes
# ffprobe            6.1.1    media metadata
# node               18.19.1  ESM runtime for the orchestrator
# python             3.12.3   analysis layer (project venv)

# ---- node ---------------------------------------------------------------
# No runtime dependencies. The orchestrator uses only node: builtins
# (child_process, fs/promises, path, url, os) and node:test for tests.
# This is deliberate: no supply-chain surface for a local pipeline.

# ---- python (services/video-intelligence/pyproject.toml) ---------------
faster-whisper>=1.0        # 1.2.1  ASR on CPU via CTranslate2; bundles Silero VAD ONNX
ctranslate2>=4.0           # 4.9.1  inference backend for faster-whisper
scenedetect>=0.6.4         # 0.7.3  shot boundary detection
pydantic>=2.5              # 2.14.4 typed models
numpy>=1.24                # 2.5.5  audio buffers
jsonschema>=4.0            # 4.26.0 artefact validation

# ---- deliberately NOT installed ----------------------------------------
# torch                      ~539 MB wheel, unused: Silero VAD runs as ONNX
# silero-vad                 pulls torch; faster_whisper.vad provides the same model
# any cloud SDK              the pipeline makes no network calls after model download

# ---- model downloads (first run, into workspace/models) ----------------
# whisper-base     ~145 MB   default: good speed/accuracy on 12 CPU cores
# whisper-small    ~480 MB   optional: better accuracy, ~3x slower
