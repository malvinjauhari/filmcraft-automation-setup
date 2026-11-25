# Context & Arsitektur — AI Video Editor

Dokumen ini menjelaskan **konteks teknis dan aturan arsitektur** yang wajib dipahami oleh developer maupun AI agent sebelum menjalankan atau memodifikasi pipeline.

---

## 1. Gambaran Besar Sistem

`ai-video-editor` adalah **local-first AI video editing agent**. Ia menganalisis footage mentah, merencanakan pemotongan (silence, dead air, filler words), membangun timeline deterministik di **FilmCraft**, lalu mengekspor video MP4 1080p beserta file proyek FilmCraft, subtitle `.srt`, dan laporan editing.

### Pemisahan Tanggung Jawab (Strict Separation)

1. **Analyzer (`services/video-intelligence/`, Python `.venv`)**
   - Tugas: observasi deterministik atas media (`probe`, `transcribe`, `VAD`, `scene detection`, `silence`).
   - **Batasan:** Python **tidak pernah** menyentuh timeline atau menjalankan perintah FilmCraft.
2. **Planner (`services/editing-orchestrator/src/plan/`, Node.js ESM)**
   - Tugas: mengubah hasil analisis (`analysis.json`) + profil editorial (`presets/*.json`) menjadi `editing-plan.json` yang tervalidasi 3 lapis (schema, reality, sanity).
   - **Batasan:** LLM/Planner hanya menghasilkan rencana JSON (`editing-plan.json`), **tidak pernah** meng-emit raw FilmCraft command secara langsung.
3. **Executor (`services/editing-orchestrator/src/timeline/` & `filmcraft/`, Node.js ESM)**
   - Tugas: mengompilasi plan yang sudah lolos validasi menjadi operasi timeline deterministik, mengeksekusinya via `filmcraft-cli` atau Bridge GUI, dan memverifikasi setiap mutasi lewat `sequence.inspect`.
   - **Batasan:** TypeScript/Node **tidak pernah** melakukan decode media secara langsung.
4. **Engine (`FilmCraft 0.17.1`)**
   - Native Rust video editor (`filmcraft` GUI & `filmcraft-cli` MCP/CLI).

---

## 2. Lima Aturan Emas (The Five Rules)

Setiap aturan ini lahir dari bug nyata yang pernah terjadi di environment ini:

### Rule 1: Jangan pernah memodifikasi source footage
- Folder sumber (`workspace/inbox/` atau `raw-video/`) bersifat **read-only**.
- Setiap file sumber di-hash (`SHA-256`) saat ingest dan di-hash ulang sebelum export. Jika ada perubahan (drift), job langsung dibatalkan.
- Jangan pernah `mv`, menimpa, atau "membersihkan" file input.

### Rule 2: Parameter perintah FilmCraft bersifat *silently permissive*
- Key yang tidak dikenal akan **diabaikan diam-diam**; tipe data yang salah bisa fallback ke nilai default.
- Return value `null` hanya berarti **perintah berjalan**, bukan berarti perintah berhasil sesuai niat.
- Contoh jebakan nyata:
  ```js
  // SALAH — clip diam-diam ditaruh di detik ke-0
  { track: "V1", time: { seconds: 6 } }

  // BENAR — `seconds` sejajar dengan `track`
  { track: "V1", seconds: 6 }
  ```
- **Wajib:** Setiap mutasi timeline harus diikuti read-back assertion (`sequence.inspect`). Lihat `services/editing-orchestrator/src/filmcraft/assert.mjs`.

### Rule 3: Integer ticks, JANGAN pernah float
- FilmCraft menggunakan **`254_016_000_000` ticks per detik**.
- Semua perhitungan tick **wajib** memakai `BigInt` di JavaScript dan `int` di Python.
- Durasi 10 jam dalam ticks sudah melebihi `Number.MAX_SAFE_INTEGER` (`9.007e15`), sehingga `Number` (float64) bukan sekadar kurang presisi — ia **salah secara matematis**.

### Rule 4: Jangan pernah hardcode command ID atau nama preset dari ingatan
- Selalu query `commands --json` dan `export --list-presets` (sudah dicek otomatis oleh `npm run verify`).
- Di versi FilmCraft `0.17.1` ini, preset 1080p H.264 bernama **`"High Quality 1080p HD"`** — nama `"H.264"` tidak ada.

### Rule 5: The LLM plans, code executes
- Model/planner menghasilkan `editing-plan.json` yang harus sesuai dengan `schemas/editing-plan.schema.json`.
- Plan divalidasi 3 lapis (schema, reality terhadap durasi media nyata, sanity terhadap aturan cut) sebelum satu pun perintah FilmCraft dijalankan.

---

## 3. Alur Pipeline End-to-End (`npm run edit`)

```
[Input Video(s)]
      │
      ▼  (1) Ingest & SHA-256 Hash
[workspace/jobs/<job>/media.json]
      │
      ▼  (2) Python: .venv/bin/python -m vidintel pipeline
[transcript.json + analysis.json]  (faster-whisper int8 + Silero VAD ONNX + PySceneDetect)
      │
      ▼  (3) Plan: propose.mjs + validate.mjs + compile.mjs
[editing-plan.json + timeline-ops.json]
      │
      ▼  (4) Execute: TimelineBuilder -> FilmCraft CLI / Bridge GUI + sequence.inspect assert
[FilmCraft Project + Exported 1080p MP4 + Subtitles .srt]
      │
      ▼  (5) QC & Integrity Re-hash: qc/check.mjs + report/write.mjs
[report.md + qc.json]
```

---

## 4. Kontrak Data & Konfigurasi

| Folder | Isi & Fungsi |
|---|---|
| `schemas/` | 5 JSON Schema kontrak: `media.schema.json`, `transcript.schema.json`, `analysis.schema.json`, `editing-plan.schema.json`, `timeline-ops.schema.json` |
| `presets/` | Profil editorial (`tutorial-id.json`, `vlog-id.json`) dan leksikon kata pengisi (`fillers.id.json`, `fillers.en.json`) |
| `apps/cli/src/main.mjs` | Entrypoint CLI job lifecycle (`--input`, `--preset`, `--job`, `--resume`, `--cut-kinds`, `--bridge`, `--no-export`, dll.) |
| `services/editing-orchestrator/src/` | Modul `filmcraft/`, `plan/`, `timeline/`, `audio/`, `subtitles/`, `qc/`, `report/` |
| `services/video-intelligence/vidintel/` | Modul `probe.py`, `audio.py`, `transcribe.py`, `vad.py`, `scenes.py`, `silence.py` |
| `.opencode/` | Definisi agent (`video-editor`, `media-analyst`, `timeline-builder`) dan skills (`filmcraft`, `video-intelligence`) beserta referensi command FilmCraft |

---

## 5. Mode Eksekusi: Headless vs Bridge GUI

1. **Headless (Default):**
   `npm run edit` menjalankan `filmcraft-cli` secara langsung di background untuk membangun timeline dan export MP4.
2. **Bridge GUI (Live Window di Layar):**
   Berguna jika ingin melihat timeline dibangun secara live di aplikasi GUI FilmCraft.
   - Terminal 1: `./scripts/bridge-gui.sh` (menjalankan `filmcraft --control 7991 --control-input-only`, mencetak `FILMCRAFT_CONTROL_TOKEN` 64-hex, dan menyimpannya ke `workspace/logs/bridge.json`).
   - Terminal 2: `export FILMCRAFT_CONTROL_TOKEN=<token>` lalu jalankan `npm run edit -- ... --bridge 127.0.0.1:7991`.

---

## 6. Lokasi Artefak per Job

Setiap job yang dijalankan tersimpan rapi di `workspace/projects/<job-id>/`:
- `output.mp4` — hasil render video 1080p
- `project.fcproj` — file proyek FilmCraft (bisa dibuka ulang di GUI)
- `subtitles.srt` — file subtitle
- `report.md` — laporan akhir editing & penghematan durasi
- `media.json`, `transcript.json`, `analysis.json`, `editing-plan.json`, `timeline-ops.json` — artefak tiap tahap pipeline
