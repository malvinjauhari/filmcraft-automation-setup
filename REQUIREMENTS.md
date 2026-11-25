# Requirements & Instalasi Dependensi

Dokumen ini berisi seluruh daftar kebutuhan sistem, dependensi Python/Node, dan model AI yang harus tersedia agar `ai-video-editor` dapat berjalan dengan lancar.

---

## 1. System Binaries (Wajib Ada di OS)

| Binary | Versi Terverifikasi | Fungsi | Cara Cek |
|---|---|---|---|
| `filmcraft` | `0.17.1` (`/usr/bin/filmcraft`) | Engine + GUI video editor berbasis Rust | `filmcraft --version` |
| `filmcraft-cli` | `0.17.1` (`/usr/bin/filmcraft-cli`) | CLI & MCP server FilmCraft (716 commands) | `filmcraft-cli --version` |
| `ffmpeg` | `6.1.1` (atau `>= 6.0`) | Decode audio/video, QC probe, burn-in subtitle | `ffmpeg -version` |
| `ffprobe` | `6.1.1` (atau `>= 6.0`) | Inspeksi metadata media & validasi hasil export | `ffprobe -version` |
| `node` | `18.19.1` (wajib `>= 18`) | Runtime ESM untuk orchestrator & CLI (`apps/cli`) | `node --version` |
| `python3` | `3.12.3` (wajib `>= 3.10`) | Runtime untuk analisis media (`services/video-intelligence`) | `python3 --version` |
| `python3-venv` | Sesuai versi Python | Membuat virtual environment `.venv/` (PEP 668 safe) | `python3 -m venv --help` |
| `openssl` | Standard Linux | Generate 64-hex `FILMCRAFT_CONTROL_TOKEN` di `bridge-gui.sh` | `openssl version` |

### Contoh Instalasi System Packages (Ubuntu / Linux Mint / Debian)

```bash
sudo apt update
sudo apt install -y ffmpeg nodejs npm python3 python3-venv python3-pip openssl
```

> **Catatan:** Pastikan `node` minimal versi **18+**. Jika bawaan `apt` terlalu tua, gunakan [NodeSource](https://github.com/nodesource/distributions) atau `nvm` untuk install Node 18/20 LTS.
> **FilmCraft:** `filmcraft` dan `filmcraft-cli` harus sudah terinstall di `/usr/bin/` (atau tersedia di `PATH`). `scripts/verify-env.mjs` memanggil `/usr/bin/filmcraft-cli` secara langsung.

---

## 2. Node.js Dependencies

**Tidak ada `node_modules` / runtime dependencies eksternal.**

`package.json` sengaja menggunakan `"dependencies": {}`. Seluruh orchestrator memakai modul bawaan Node.js (`node:child_process`, `node:fs/promises`, `node:path`, `node:url`, `node:crypto`, `node:test`) agar zero supply-chain risk dan tidak perlu `npm install`.

---

## 3. Python Dependencies (`.venv` — CPU-Only)

Semua package Python diinstall ke dalam `.venv/` (karena sistem Python modern memakai PEP 668 externally-managed) melalui `services/video-intelligence/pyproject.toml`:

| Package | Constraint | Versi Terverifikasi | Fungsi |
|---|---|---|---|
| `faster-whisper` | `>=1.0` | `1.2.1` | Transkripsi ASR di CPU via CTranslate2 + **bundled Silero VAD ONNX** |
| `ctranslate2` | `>=4.0` | `4.9.1` | Backend inferensi `int8` cepat di CPU (otomatis terinstall oleh `faster-whisper`) |
| `scenedetect` | `>=0.6.4` | `0.7.3` | Deteksi perpindahan shot / scene boundary |
| `pydantic` | `>=2.5` | `2.14.4` | Validasi & skema data internal Python |
| `numpy` | `>=1.24` | `2.5.5` | Pengolahan buffer audio |
| `jsonschema` | `>=4.0` | `4.26.0` | Validasi kontrak artefak JSON (`media.json`, `analysis.json`, dll.) |

### Yang SENGAJA TIDAK Diinstall

- **`torch`** (~539 MB) — **Jangan install!** Tidak dipakai sama sekali; Silero VAD berjalan via ONNX di dalam `faster_whisper.vad`.
- **`silero-vad`** — Menarik `torch` sebagai dependensi; gunakan `faster_whisper.vad` saja.
- **Cloud SDK / API keys** — Pipeline berjalan 100% lokal (offline setelah model Whisper terunduh).

---

## 4. Model AI (Download Otomatis / Sekali di Awal)

Model Whisper disimpan di `workspace/models/` (bisa di-pre-download lewat `./setup.sh --with-model` atau otomatis terunduh saat job pertama dijalankan):

| Model | Ukuran | Keterangan |
|---|---|---|
| `base` (`Systran/faster-whisper-base`) | ~145 MB | **Default.** Seimbang antara kecepatan dan akurasi di CPU (`int8`) |
| `small` (`Systran/faster-whisper-small`) | ~480 MB | Opsional (`--model small`). Akurasi lebih tinggi, ~3x lebih lambat |

---

## 5. Hardware Minimum / Referensi

- **CPU:** Multi-core CPU (diuji pada 12 cores, `int8` quantization via CTranslate2)
- **RAM:** 8–16 GB (diuji pada 14 GB RAM)
- **GPU:** Tidak wajib (**no GPU** — semua berjalan di CPU)

---

## 6. Verifikasi Setelah Setup

Setelah menjalankan `./setup.sh`, pastikan semua check lolos:

```bash
npm run verify   # Cek semua binary, Python modules, 19 FilmCraft commands, dan preset "High Quality 1080p HD"
npm test         # Jalankan unit & contract tests
npm run smoke    # (Opsional) End-to-end synthetic build → MP4 untuk membuktikan pipeline jalan penuh
```
