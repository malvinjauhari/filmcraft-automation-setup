#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${FILMCRAFT_CONTROL_PORT:-7991}"
mkdir -p "${ROOT_DIR}/workspace/logs"
BRIDGE_FILE="${ROOT_DIR}/workspace/logs/bridge.json"

if [[ -z "${FILMCRAFT_CONTROL_TOKEN:-}" ]] && [[ -f "${BRIDGE_FILE}" ]]; then
  FILMCRAFT_CONTROL_TOKEN="$(node -e "try{const d=JSON.parse(require('fs').readFileSync('${BRIDGE_FILE}','utf8'));if(/^[0-9a-f]{64}$/i.test(d.token))console.log(d.token)}catch{}")"
fi
if [[ -z "${FILMCRAFT_CONTROL_TOKEN:-}" ]]; then
  FILMCRAFT_CONTROL_TOKEN="$(openssl rand -hex 32)"
fi
export FILMCRAFT_CONTROL_TOKEN

printf '{"host":"127.0.0.1","port":%s,"token":"%s"}\n' "${PORT}" "${FILMCRAFT_CONTROL_TOKEN}" > "${BRIDGE_FILE}"
chmod 600 "${BRIDGE_FILE}"

echo "FilmCraft Bridge GUI starting on 127.0.0.1:${PORT}"
echo "Token saved to ${BRIDGE_FILE}"
echo "export FILMCRAFT_CONTROL_TOKEN=${FILMCRAFT_CONTROL_TOKEN}"

exec filmcraft --control "${PORT}" --control-input-only "$@"
