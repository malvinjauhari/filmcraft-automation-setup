# FilmCraft MCP & Bridge Notes

Catatan operasional untuk **FilmCraft (`0.17.1` / `0.17.13+`)** di `ai-video-automation`.

---

## 1. Headless Mode vs App Bridge Mode

| Aspek | Headless Mode (Default) | App Bridge Mode (`--bridge 127.0.0.1:7991`) |
|---|---|---|
| Perintah | `npm run run -- --input ...` | Terminal 1: `./scripts/bridge-gui.sh`<br>Terminal 2: `npm run run -- --input ... --bridge 127.0.0.1:7991` |
| Tampilan | Tanpa GUI (background `filmcraft-cli`) | Live GUI FilmCraft di layar |
| Token | Tidak perlu | **Wajib** `FILMCRAFT_CONTROL_TOKEN` (64-char hex) |
| Sumber Token | — | `.env` atau `workspace/logs/bridge.json` |

---

## 2. Jebakan Umum FilmCraft (Wajib Dihindari)

1. **Parameter perintah bersifat *silently permissive***
   Key yang tidak dikenal akan diabaikan diam-diam; return `null` hanya berarti perintah berjalan, bukan berhasil.
   ```js
   // SALAH — clip ditaruh di detik 0
   { track: "V1", time: { seconds: 6 } }

   // BENAR — `seconds` sejajar dengan `track`
   { track: "V1", seconds: 6 }
   ```
   Setiap mutasi timeline **wajib** diikuti `sequence.inspect` read-back assertion (`services/editing-orchestrator/src/filmcraft/assert.mjs`).

2. **Nama preset export 1080p**
   Preset 1080p H.264 adalah `"High Quality 1080p HD"` (bukan `"H.264"`). Selalu query lewat `export.presets.list`.

3. **Data dir MCP**
   `.opencode/opencode.json` mengarahkan `--data-dir` ke `<PROJECT_ROOT>/workspace/.filmcraft-data` dan di-generate otomatis oleh `./setup.sh`.
