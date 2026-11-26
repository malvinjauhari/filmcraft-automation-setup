# Agent Guide — AI Video Automation

Quick-reference wajib untuk AI agent (OpenCode, T3 Code, Claude Code, Antigravity) yang bekerja di workspace `ai-video-automation/`.

---

## 1. Perintah CLI Utama

```bash
# Jalankan end-to-end (URL YouTube/media ATAU file lokal)
npm run run -- --input "<URL_ATAU_PATH_LOKAL>" --preset tutorial-id

# Alias lain yang tersedia
npm run automate -- --input "<URL_ATAU_PATH_LOKAL>" --preset tutorial-id
npm run edit     -- --input "<PATH_LOKAL>" --preset tutorial-id

# Simulasi dry-run (tanpa download & tanpa mutasi timeline)
npm run run -- --input "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --dry-run

# Verifikasi environment & jalankan unit/contract tests
npm run verify
npm test
```

---

## 2. Membaca `FILMCRAFT_CONTROL_TOKEN`

Untuk **App Bridge Mode** (live preview di GUI FilmCraft pada `127.0.0.1:7991`):
1. Token 64-hex disimpan otomatis oleh `./setup.sh` di:
   - `.env` (`FILMCRAFT_CONTROL_TOKEN=...`, `FILMCRAFT_CONTROL_PORT=7991`)
   - `workspace/logs/bridge.json` (`{"host":"127.0.0.1","port":7991,"token":"<64-hex>"}`)
2. CLI (`apps/cli/src/main.mjs`) otomatis membaca token dari `process.env.FILMCRAFT_CONTROL_TOKEN`, flag `--control-token`, atau fallback ke `workspace/logs/bridge.json`.
3. Untuk menyalakan GUI Bridge: `./scripts/bridge-gui.sh` di terminal terpisah, lalu jalankan `npm run run -- ... --bridge 127.0.0.1:7991`.

---

## 3. Aturan Wajib (Tidak Boleh Dilanggar)

1. **Jangan pernah memodifikasi atau menghapus source footage** (`workspace/raw-video/` atau input lokal). Semua sumber di-hash SHA-256 saat ingest dan di-hash ulang sebelum export.
2. **Integer ticks (`BigInt` di JS, `int` di Python)** — `254_016_000_000` ticks/detik. Jangan pernah pakai float (`Number`) untuk aritmetika tick.
3. **The LLM plans, code executes** — AI agent/planner hanya menghasilkan `editing-plan.json` yang sesuai `schemas/editing-plan.schema.json`. Jangan pernah meng-emit raw FilmCraft command tanpa validasi 3 lapis (`schema`, `reality`, `sanity`).
4. **Python vs TypeScript separation** — Python (`services/video-intelligence`) hanya observasi media (never touches timeline); TypeScript (`services/editing-orchestrator`) hanya orkestrasi & FilmCraft MCP (never decodes media).
5. **Silero VAD ONNX (NO `torch`)** — Deteksi voice activity menggunakan `faster_whisper.vad` (`silero_vad_v6.onnx`). Jangan install `torch` atau `silero-vad` PyPI.
6. **Jangan hardcode command ID / nama preset** — Query `commands --json` & `export --list-presets`. Preset 1080p H.264 adalah `"High Quality 1080p HD"`.
