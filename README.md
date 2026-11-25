# AI Video Setup Clone — Portable Starter & Reference

Folder ini adalah **paket siap pakai (self-contained)** untuk menjalankan **AI Video Editor** di mesin atau direktori baru tanpa setup ribet. Cukup copy folder `ai-video-setup-clone` ini, jalankan satu perintah setup, dan pipeline langsung siap digunakan.

---

## 1. Prasyarat Sistem

Pastikan binary berikut sudah terinstall di mesin target (detail lengkap ada di [REQUIREMENTS.md](./REQUIREMENTS.md)):
- `filmcraft` & `filmcraft-cli` (`0.17.1` di `/usr/bin/`)
- `ffmpeg` & `ffprobe`
- `node` (`>= 18`) & `npm`
- `python3` & `python3-venv` (`>= 3.10`)
- `openssl` (untuk generate `FILMCRAFT_CONTROL_TOKEN`)
- `opencode` *(opsional — hanya jika menjalankan orkestrasi agen via OpenCode CLI)*

---

## 2. Setup Otomatis (1 Perintah)

Masuk ke folder ini lalu jalankan:

```bash
./setup.sh
```

Atau sekalian pre-download model Whisper `base` (~145 MB) agar siap offline:

```bash
./setup.sh --with-model
```

Script `setup.sh` akan otomatis:
1. Mengecek binary sistem wajib (`filmcraft`, `filmcraft-cli`, `ffmpeg`, `ffprobe`, `node`, `python3`, `openssl`) serta mengecek `opencode` (opsional).
2. Menjalankan `npm install` untuk dependensi Node.js.
3. Membuat `.venv/`, menginstall `services/video-intelligence` (`faster-whisper`, `scenedetect`, `pydantic`, `numpy`, `jsonschema` — CPU-only, **tanpa `torch`**), dan memverifikasi **Silero VAD ONNX** (`faster_whisper.vad`) aktif.
4. Membuat folder `workspace/{inbox,projects,models,logs,.filmcraft-data}` & `raw-video/`, meng-generate `.opencode/opencode.json` sesuai path direktori saat ini, menyalin skill `@filmcraft` ke `~/.config/opencode/skills/filmcraft`, serta meng-generate `FILMCRAFT_CONTROL_TOKEN` (64-hex) ke `workspace/logs/bridge.json`.
5. *(Jika pakai `--with-model`)* Pre-download model `faster-whisper` `base` ke `workspace/models/`.
6. Menjalankan `npm run verify`.
7. Menjalankan `npm test` *(bisa dilewati dengan `--skip-tests`)*.

*(Opsional)* Untuk membuktikan pipeline end-to-end dari sintesis video sampai export MP4:
```bash
npm run smoke
```

---

## 3. Cara Pakai Cepat

### A. Edit Video Secara Headless (Otomatis Penuh)

Taruh file video di `raw-video/` atau `workspace/inbox/<nama-job>/`, lalu jalankan:

```bash
npm run edit -- --input raw-video/video.mp4 --preset tutorial-id --job my-video
```

Contoh dengan filter cut tertentu & tanpa burn-in subtitle:

```bash
npm run edit -- \
  --input "raw-video/video.mp4" \
  --preset tutorial-id \
  --job my-video \
  --cut-kinds silence,dead_air \
  --no-burn-captions
```

### B. Mode Bridge GUI (Melihat Timeline Dibangun Live di FilmCraft)

`./setup.sh` sudah otomatis membuat `FILMCRAFT_CONTROL_TOKEN` di `workspace/logs/bridge.json`. Saat Anda menjalankan `bridge-gui.sh` dan `npm run edit -- --bridge`, token tersebut otomatis dipakai:

```bash
# Terminal 1: nyalakan GUI FilmCraft dengan control port 7991
./scripts/bridge-gui.sh

# Terminal 2: jalankan edit terhubung ke GUI (token otomatis dibaca dari workspace/logs/bridge.json)
npm run edit -- --input "raw-video/video.mp4" --preset tutorial-id --job my-video --bridge 127.0.0.1:7991
```

### C. Lokasi Hasil Video Setelah Edit

Saat mulai dan selesai membuat video, CLI akan langsung menampilkan lokasi output-nya di terminal:
- **Folder job:** `workspace/projects/<job-id>/`
- **Video MP4:** `workspace/projects/<job-id>/output.mp4`
- **Proyek FilmCraft:** `workspace/projects/<job-id>/project.fcproj`
- **Subtitle:** `workspace/projects/<job-id>/subtitles.srt`
- **Laporan:** `workspace/projects/<job-id>/report.md`

### C. Opsi CLI Penting (`apps/cli/src/main.mjs`)

| Flag | Keterangan |
|---|---|
| `--input <path...>` | File atau folder input video |
| `--preset <nama>` | Profil editorial: `tutorial-id` (default) atau `vlog-id` |
| `--job <id>` | Nama/ID job di `workspace/jobs/<id>` |
| `--resume` | Lanjutkan job yang sudah ada (skip tahap analisis jika sudah ada) |
| `--cut-kinds <list>` | Jenis cut yang dipakai, misal `silence,dead_air` |
| `--model <nama>` | Model Whisper: `base` (default) atau `small` |
| `--no-burn-captions` | Jangan burn-in subtitle ke video MP4 |
| `--no-export` | Bangun proyek FilmCraft saja tanpa render MP4 |
| `--bridge [host:port]` | Hubungkan ke GUI FilmCraft (default `127.0.0.1:7991`) |

---

## 4. Dokumen yang Wajib Dipahami

- **[CONTEXT.md](./CONTEXT.md)** — Arsitektur sistem, 5 Aturan Emas, tick math (`254_016_000_000` ticks/detik), alur pipeline, dan jebakan FilmCraft.
- **[REQUIREMENTS.md](./REQUIREMENTS.md)** — Daftar lengkap binary, Python packages, model Whisper, dan hal yang sengaja tidak diinstall.
- **[AGENTS.md](./AGENTS.md)** — Instruksi ringkas untuk AI coding agent (OpenCode / Antigravity / dll).
- **[DEPENDENCIES.md](./DEPENDENCIES.md)** — Catatan versi terverifikasi.
