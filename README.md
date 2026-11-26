# AI Video Setup Clone — Portable Starter, Automation & Reference

Folder ini adalah **paket siap pakai (self-contained)** untuk menjalankan **AI Video Editor** berbasis **FilmCraft MCP** (plus modul opsional **auto-download CLI** di folder terpisah `automation/`). Cukup copy folder `ai-video-setup-clone` ini ke mesin/direktori baru, jalankan `./setup.sh`, dan pipeline langsung siap digunakan.

---

## 1. Struktur Pemisahan (Zero Duplication)

- **Video Editor (inti):**
  - `apps/cli/` — CLI editor (`npm run edit`)
  - `services/video-intelligence/` — Python analyzer (`faster-whisper` `int8` + **Silero VAD ONNX** + `PySceneDetect`)
  - `services/editing-orchestrator/` — kompilasi plan JSON deterministik ke perintah FilmCraft + QC + report
  - `schemas/`, `presets/`, `scripts/`, `tests/`, `.opencode/`
- **Downloader & Automation (terpisah di `automation/`):**
  - [automation/libreget.mjs](./automation/libreget.mjs) — wrapper Node.js untuk `libreget-cli`
  - [automation/run.mjs](./automation/run.mjs) — alur `URL -> download -> apps/cli/src/main.mjs` (`npm run automate`)
  - [automation/setup-downloader.sh](./automation/setup-downloader.sh) — installer binary `libreget-cli` ke `bin/libreget`
  - [automation/docs/](./automation/docs/AGENT_GUIDE.md) — dokumentasi khusus AI agent (`AGENT_GUIDE.md`, `PIPELINE_FLOW.md`, `LIBREGET_CLI_REFERENCE.md`, `FILMCRAFT_MCP_NOTES.md`)

---

## 2. Prasyarat Sistem

Pastikan binary berikut sudah terinstall di mesin target (detail lengkap ada di [REQUIREMENTS.md](./REQUIREMENTS.md)):
- `filmcraft` & `filmcraft-cli` (`0.17.1` / `0.17.13+` di `/usr/bin/`)
- `ffmpeg` & `ffprobe`
- `node` (`>= 18`) & `npm`
- `python3` & `python3-venv` (`>= 3.10`)
- `openssl` (untuk generate `FILMCRAFT_CONTROL_TOKEN`)
- `yt-dlp` & `curl` *(jika memakai mode Full / Downloader Automation)*
- `opencode` *(opsional — hanya jika orkestrasi lewat OpenCode CLI)*

---

## 3. Setup Interaktif (1 Perintah)

Masuk ke folder ini lalu jalankan:

```bash
./setup.sh
```

`setup.sh` akan bertanya secara interaktif di terminal:
- **Pilihan 1 (`--editor-only`)**: Install **Sistem Video Editor Saja** (`.venv` + Silero VAD ONNX tanpa `torch`, `npm install`, skill `@filmcraft` ke `~/.config/opencode/skills/filmcraft`, `.opencode/opencode.json`, serta `FILMCRAFT_CONTROL_TOKEN` ke `.env` & `workspace/logs/bridge.json`).
- **Pilihan 2 (`--full`)**: Install **Video Editor + Downloader Automation** (semua komponen Pilihan 1 + menjalankan `automation/setup-downloader.sh` untuk mengunduh binary rilis resmi `libreget-cli` ke `bin/libreget`).

Flag non-interaktif untuk CI / AI agent:
```bash
./setup.sh --editor-only --with-model
./setup.sh --full --with-model
```

*(Opsional)* Uji end-to-end pipeline sintetis hingga export MP4:
```bash
npm run smoke
```

---

## 4. Cara Pakai Cepat

### A. Edit Video Lokal (`npm run edit`)

```bash
npm run edit -- --input raw-video/video.mp4 --preset tutorial-id --job my-video
```

### B. Auto-Download URL -> Auto-Edit (`npm run automate`)

```bash
# Simulasi dry-run terlebih dahulu
npm run automate -- --input "https://www.youtube.com/watch?v=..." --dry-run

# Eksekusi penuh (download 1080p via libreget-cli -> auto-cut -> export 1080p MP4)
npm run automate -- --input "https://www.youtube.com/watch?v=..." --preset tutorial-id
```

### C. Mode Bridge GUI (Live Preview di FilmCraft)

`./setup.sh` sudah otomatis membuat `FILMCRAFT_CONTROL_TOKEN` di `.env` dan `workspace/logs/bridge.json`:

```bash
# Terminal 1: nyalakan GUI FilmCraft dengan control port 7991
./scripts/bridge-gui.sh

# Terminal 2: jalankan edit / automate terhubung ke GUI
npm run edit -- --input "raw-video/video.mp4" --preset tutorial-id --job my-video --bridge 127.0.0.1:7991
```

### D. Lokasi Hasil Video Setelah Edit

Saat mulai dan selesai membuat video, CLI akan langsung menampilkan lokasi output-nya di terminal:
- **Folder job:** `workspace/projects/<job-id>/`
- **Video MP4:** `workspace/projects/<job-id>/output.mp4`
- **Proyek FilmCraft:** `workspace/projects/<job-id>/project.fcproj`
- **Subtitle:** `workspace/projects/<job-id>/subtitles.srt`
- **Laporan:** `workspace/projects/<job-id>/report.md`

---

## 5. Dokumen Teknis & Konteks

- **[CONTEXT.md](./CONTEXT.md)** — Arsitektur sistem, 5 Aturan Emas, tick math (`254_016_000_000` ticks/detik), dan jebakan FilmCraft.
- **[REQUIREMENTS.md](./REQUIREMENTS.md)** — Daftar lengkap binary, Python packages, model Whisper, dan alasan tanpa `torch`.
- **[AGENTS.md](./AGENTS.md)** — Instruksi ringkas untuk AI coding agent.
- **[DEPENDENCIES.md](./DEPENDENCIES.md)** — Catatan versi terverifikasi.
- **[automation/docs/](./automation/docs/AGENT_GUIDE.md)** — Dokumentasi AI agent untuk alur `libreget-cli`, pipeline flow, dan FilmCraft MCP.

---

## 6. Attribution, Lisensi & Kepatuhan Legal

### A. Asal Proyek (Fork / Upstream)
- Basis skill & konfigurasi agent FilmCraft (`.opencode/skills/filmcraft/`) berasal dari fork repositori:
  **[`AHL8192/opencode-craft-skills`](https://github.com/AHL8192/opencode-craft-skills)**.
- Untuk detail lisensi skill upstream, silakan merujuk langsung ke repositori [`AHL8192/opencode-craft-skills`](https://github.com/AHL8192/opencode-craft-skills) (repositori upstream tidak mencantumkan file `LICENSE` eksplisit pada indeks publik; hak cipta tetap melekat pada penulis aslinya).

### B. Integrasi `libreget-cli` (`OpenSelena/libreget`) — Apa Saja yang Diambil
Repositori **[`OpenSelena/libreget`](https://github.com/OpenSelena/libreget)** berlisensi **GNU General Public License v3.0 (GPL-3.0)**. Agar tetap bersih dan patuh terhadap ketentuan lisensi:
1. **Yang diambil / digunakan:**
   - Hanya **binary rilis resmi `libreget-cli`** (`libreget-cli-<version>-<target>`) yang diunduh langsung oleh pengguna saat menjalankan `./setup.sh --full` (`automation/setup-downloader.sh`) dari halaman [GitHub Releases `OpenSelena/libreget`](https://github.com/OpenSelena/libreget/releases) ke `bin/libreget`.
   - Pemanggilan dilakukan sebagai **proses CLI eksternal terpisah** (`libreget info`, `libreget download`) melalui wrapper [`automation/libreget.mjs`](./automation/libreget.mjs).
   - Rangkuman penggunaan perintah CLI (`info`, `download`, `batch`, `import-cookies`, `--audio-only`, `--subs`) pada [`automation/docs/LIBREGET_CLI_REFERENCE.md`](./automation/docs/LIBREGET_CLI_REFERENCE.md).
2. **Yang TIDAK diambil & TIDAK didistribusikan ulang:**
   - Seluruh kode sumber aplikasi desktop Tauri/Svelte (`src/`, `src-tauri/`) **tidak** di-clone atau disalin ke proyek ini.
   - Binary `libreget` **tidak** di-bundle atau di-commit di dalam repositori ini (dikecualikan di `.gitignore` pada `bin/libreget`).

### C. Dependensi Pihak Ketiga Lainnya
- **FilmCraft** (`filmcraft`, `filmcraft-cli`) — perangkat lunak terpisah yang sudah terpasang di sistem pengguna.
- **FFmpeg / FFprobe** — LGPL/GPL (dipanggil sebagai binary sistem terpisah).
- **faster-whisper / CTranslate2 / Silero VAD ONNX / PySceneDetect / Pydantic / NumPy / jsonschema** — diinstall ke `.venv/` sesuai lisensi masing-masing proyek open-source-nya.

---

## 7. Disclaimer

1. **Tanggung Jawab Konten & Hak Cipta:** Pengguna bertanggung jawab penuh atas URL dan media yang diunduh maupun diedit menggunakan `libreget-cli` dan pipeline ini. Pastikan Anda memiliki izin atau hak yang sah atas konten tersebut serta mematuhi *Terms of Service* platform sumber dan hukum hak cipta yang berlaku.
2. **Tanpa Jaminan (As-Is):** Perangkat lunak dan skrip otomasi ini disediakan *"AS IS"*, tanpa jaminan apa pun, baik tersurat maupun tersirat. Penulis dan kontributor tidak bertanggung jawab atas kehilangan data, kerusakan file, atau klaim hukum akibat penggunaan alat ini.
3. **Keamanan File Asli:** Pipeline dirancang *local-first* dan *read-only* terhadap source footage (`SHA-256` diverifikasi sebelum export), namun pengguna tetap disarankan menyimpan cadangan (*backup*) video penting sebelum memproses proyek besar.
