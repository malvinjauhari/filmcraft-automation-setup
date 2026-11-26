#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

MODE=""
WITH_MODEL=false
RUN_SMOKE=false
SKIP_TESTS=false

for arg in "$@"; do
  case "$arg" in
    --editor-only) MODE="editor-only" ;;
    --full)        MODE="full" ;;
    --with-model)  WITH_MODEL=true ;;
    --smoke)       RUN_SMOKE=true ;;
    --skip-tests)  SKIP_TESTS=true ;;
    -h|--help)
      cat <<'EOF'
Usage: ./setup.sh [options]

Bootstrap ai-video-editor + optional downloader automation:
  Pilihan 1 (--editor-only) : Video Editor only (Python .venv + Silero VAD ONNX, npm install, @filmcraft skill, FILMCRAFT_CONTROL_TOKEN)
  Pilihan 2 (--full)        : Video Editor + Downloader Automation (runs automation/setup-downloader.sh for libreget-cli + yt-dlp)

Options:
  --editor-only  Non-interactive: install Video Editor only
  --full         Non-interactive: install Video Editor + libreget-cli downloader
  --with-model   Pre-download faster-whisper "base" model (~145 MB) into workspace/models/
  --smoke        Run end-to-end synthetic smoke test (npm run smoke) after setup
  --skip-tests   Skip npm test
  -h, --help     Show this help
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${MODE}" ]]; then
  echo "============================================================"
  echo "  AI Video Setup — Pilih Mode Instalasi"
  echo "============================================================"
  echo "  [1] Install Sistem Video Editor Saja (local file -> auto-edit)"
  echo "  [2] Install Sistem Video Editor + Downloader Automation (URL -> download -> auto-edit)"
  echo ""
  read -r -p "Pilih mode instalasi [1/2] (default: 2): " CHOICE
  case "${CHOICE:-2}" in
    1) MODE="editor-only" ;;
    2) MODE="full" ;;
    *)
      echo "Pilihan tidak valid: ${CHOICE}" >&2
      exit 1
      ;;
  esac
fi

echo "==> Mode terpilih: ${MODE}"

echo "==> [1/7] Checking system binaries..."
MISSING=0
for bin in filmcraft filmcraft-cli ffmpeg ffprobe node python3 openssl; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "  ✓ $bin ($(command -v "$bin"))"
  else
    echo "  ✗ $bin NOT FOUND"
    MISSING=1
  fi
done

if command -v opencode >/dev/null 2>&1; then
  echo "  ✓ opencode ($(command -v opencode))"
else
  echo "  ! opencode NOT FOUND (optional — only needed if running agent orchestration via OpenCode CLI)"
fi

if [[ "$MISSING" -ne 0 ]]; then
  echo ""
  echo "Some required system binaries are missing. See REQUIREMENTS.md for install instructions." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "  ✗ Node.js >= 18 required (found $(node -v))" >&2
  exit 1
fi

echo "==> [2/7] Installing Node.js dependencies (npm install)..."
if command -v npm >/dev/null 2>&1; then
  npm install --no-audit --no-fund
  echo "  ✓ npm install complete"
else
  echo "  ✗ npm NOT FOUND" >&2
  exit 1
fi

echo "==> [3/7] Setting up Python virtual environment (.venv) & Silero VAD ONNX..."
if [[ ! -d "${ROOT_DIR}/.venv" ]]; then
  python3 -m venv "${ROOT_DIR}/.venv"
  echo "  ✓ Created .venv"
else
  echo "  ✓ .venv already exists"
fi

"${ROOT_DIR}/.venv/bin/pip" install --upgrade pip --quiet
"${ROOT_DIR}/.venv/bin/pip" install -e "${ROOT_DIR}/services/video-intelligence" --quiet
"${ROOT_DIR}/.venv/bin/python" -c "from faster_whisper.vad import VadOptions, get_speech_timestamps; print('  ✓ vidintel + Silero VAD ONNX (faster_whisper.vad, CPU-only, no torch) ready')"

echo "==> [4/7] Creating workspace, OpenCode config/skills & FILMCRAFT_CONTROL_TOKEN..."
mkdir -p "${ROOT_DIR}/workspace/inbox" \
         "${ROOT_DIR}/workspace/projects" \
         "${ROOT_DIR}/workspace/models" \
         "${ROOT_DIR}/workspace/logs" \
         "${ROOT_DIR}/workspace/.filmcraft-data" \
         "${ROOT_DIR}/raw-video"

if [[ -f "${ROOT_DIR}/.opencode/opencode.json.template" ]]; then
  sed "s|__PROJECT_ROOT__|${ROOT_DIR}|g" \
    "${ROOT_DIR}/.opencode/opencode.json.template" > "${ROOT_DIR}/.opencode/opencode.json"
  echo "  ✓ Generated .opencode/opencode.json for ${ROOT_DIR}"
fi

# Install @filmcraft skill globally for OpenCode / T3 Code if $HOME is writable
if [[ -d "${ROOT_DIR}/.opencode/skills/filmcraft" ]] && [[ -n "${HOME:-}" ]]; then
  GLOBAL_SKILLS_DIR="${HOME}/.config/opencode/skills"
  if mkdir -p "${GLOBAL_SKILLS_DIR}" 2>/dev/null; then
    rm -rf "${GLOBAL_SKILLS_DIR}/filmcraft"
    cp -r "${ROOT_DIR}/.opencode/skills/filmcraft" "${GLOBAL_SKILLS_DIR}/filmcraft"
    echo "  ✓ Installed @filmcraft skill -> ${GLOBAL_SKILLS_DIR}/filmcraft"
  else
    echo "  ! Could not write ${GLOBAL_SKILLS_DIR}; using local .opencode/skills/filmcraft"
  fi
fi

# Initialize FILMCRAFT_CONTROL_TOKEN (64-hex) for Bridge GUI mode
BRIDGE_FILE="${ROOT_DIR}/workspace/logs/bridge.json"
BRIDGE_PORT="${FILMCRAFT_CONTROL_PORT:-7991}"
if [[ -f "${BRIDGE_FILE}" ]]; then
  EXISTING_TOKEN="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${BRIDGE_FILE}','utf8'));if(/^[0-9a-f]{64}$/i.test(d.token))console.log(d.token)}catch{}")"
else
  EXISTING_TOKEN=""
fi

if [[ -n "${EXISTING_TOKEN}" ]]; then
  FILMCRAFT_CONTROL_TOKEN="${EXISTING_TOKEN}"
  echo "  ✓ FILMCRAFT_CONTROL_TOKEN already exists in workspace/logs/bridge.json"
else
  FILMCRAFT_CONTROL_TOKEN="$(openssl rand -hex 32)"
  printf '{"host":"127.0.0.1","port":%s,"token":"%s"}\n' "${BRIDGE_PORT}" "${FILMCRAFT_CONTROL_TOKEN}" > "${BRIDGE_FILE}"
  chmod 600 "${BRIDGE_FILE}"
  echo "  ✓ Generated FILMCRAFT_CONTROL_TOKEN -> workspace/logs/bridge.json"
fi

cat > "${ROOT_DIR}/.env" <<EOF
FILMCRAFT_CONTROL_PORT=${BRIDGE_PORT}
FILMCRAFT_CONTROL_TOKEN=${FILMCRAFT_CONTROL_TOKEN}
EOF
chmod 600 "${ROOT_DIR}/.env"
echo "  ✓ Saved FILMCRAFT_CONTROL_TOKEN -> .env"

if [[ "${MODE}" == "full" ]]; then
  echo "==> [4b] Installing Downloader Automation (automation/setup-downloader.sh)..."
  bash "${ROOT_DIR}/automation/setup-downloader.sh"
fi

if [[ "$WITH_MODEL" == true ]]; then
  echo "==> [5/7] Pre-downloading faster-whisper 'base' model into workspace/models/..."
  "${ROOT_DIR}/.venv/bin/python" -c "
from faster_whisper import WhisperModel
WhisperModel('base', device='cpu', compute_type='int8', download_root='${ROOT_DIR}/workspace/models')
print('  ✓ faster-whisper base model ready')
"
else
  echo "==> [5/7] Skipping model pre-download (pass --with-model to download now)"
fi

echo "==> [6/7] Verifying environment (npm run verify)..."
npm run verify

if [[ "$SKIP_TESTS" == false ]]; then
  echo "==> [7/7] Running unit & contract tests (npm test)..."
  npm test
else
  echo "==> [7/7] Skipping tests (--skip-tests)"
fi

if [[ "$RUN_SMOKE" == true ]]; then
  echo "==> Running end-to-end smoke test (npm run smoke)..."
  npm run smoke
fi

echo ""
echo "Setup complete!"
echo "  FILMCRAFT_CONTROL_TOKEN : ${FILMCRAFT_CONTROL_TOKEN}"
echo "  Token file              : ${BRIDGE_FILE}"
echo "  (Bridge mode reads workspace/logs/bridge.json automatically, or run:"
echo "   export FILMCRAFT_CONTROL_TOKEN=${FILMCRAFT_CONTROL_TOKEN})"
echo ""
echo "Quick start:"
echo "  npm run edit -- --input raw-video/your-video.mp4 --preset tutorial-id"
echo "  ./scripts/bridge-gui.sh   # optional: live FilmCraft GUI mode"
