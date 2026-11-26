#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

echo "==> Checking downloader dependencies (curl, yt-dlp)..."
for bin in curl yt-dlp; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "  ✓ $bin ($(command -v "$bin"))"
  else
    echo "  ! $bin NOT FOUND (needed by libreget-cli; install via apt/pipx)"
  fi
done

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64)   TARGET_PATTERN="x86_64-unknown-linux|linux-x64|linux-amd64|x86_64.*linux" ;;
  aarch64|arm64)  TARGET_PATTERN="aarch64-unknown-linux|linux-arm64|aarch64.*linux" ;;
  *)
    echo "  ✗ Unsupported architecture for libreget-cli: ${ARCH}" >&2
    exit 1
    ;;
esac

if [[ -x "${ROOT_DIR}/bin/libreget" ]]; then
  echo "  ✓ bin/libreget already installed ($("${ROOT_DIR}/bin/libreget" --version 2>/dev/null || echo 'executable'))"
  exit 0
fi

echo "==> Fetching latest libreget-cli release from OpenSelena/libreget (CLI-only, no GUI)..."
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/OpenSelena/libreget/releases/latest")"
ASSET_URL="$(node -e "
  const data = JSON.parse(process.argv[1]);
  const re = new RegExp('${TARGET_PATTERN}', 'i');
  const asset = (data.assets || []).find(a => /libreget-cli/i.test(a.name) && re.test(a.name) && !/\\.(sha256|sig|asc)$/i.test(a.name));
  if (asset) console.log(asset.browser_download_url);
" "${RELEASE_JSON}")"

if [[ -z "${ASSET_URL}" ]]; then
  echo "  ! Could not auto-match libreget-cli asset from OpenSelena/libreget latest release."
  echo "    Download manually from https://github.com/OpenSelena/libreget/releases and place at ${ROOT_DIR}/bin/libreget"
  exit 0
fi

echo "  Downloading ${ASSET_URL}..."
TMP_ASSET="$(mktemp)"
curl -fsSL "${ASSET_URL}" -o "${TMP_ASSET}"
if [[ "${ASSET_URL}" == *.tar.gz ]] || [[ "${ASSET_URL}" == *.tgz ]]; then
  TMP_DIR="$(mktemp -d)"
  tar -xzf "${TMP_ASSET}" -C "${TMP_DIR}"
  FOUND_BIN="$(find "${TMP_DIR}" -type f -name 'libreget*' | head -n 1)"
  mv "${FOUND_BIN}" "${ROOT_DIR}/bin/libreget"
  rm -rf "${TMP_DIR}" "${TMP_ASSET}"
else
  mv "${TMP_ASSET}" "${ROOT_DIR}/bin/libreget"
fi
chmod +x "${ROOT_DIR}/bin/libreget"
echo "  ✓ Installed libreget-cli -> ${ROOT_DIR}/bin/libreget"
