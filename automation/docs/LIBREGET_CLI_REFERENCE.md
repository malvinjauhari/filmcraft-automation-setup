# LibreGet CLI Reference (`libreget-cli`)

`ai-video-automation` menggunakan **`libreget-cli`** dari repositori [`OpenSelena/libreget`](https://github.com/OpenSelena/libreget) secara **CLI-only (tanpa GUI Tauri/Svelte)**.

- **Lokasi Binary:** `bin/libreget` (atau `~/.local/bin/libreget` / `PATH`).
- **Wrapper Node.js:** `services/media-downloader/src/libreget.mjs`.
- **Dependensi Bawah Layar:** `yt-dlp` dan `ffmpeg`.

---

## Perintah yang Digunakan Pipeline

### 1. Inspect Metadata (`info`)
Mengambil judul, daftar format/resolusi, durasi, dan chapter tanpa mengunduh video:
```bash
libreget info "<URL>"
```

### 2. Download Video (`download`)
Mengunduh video ke `workspace/raw-video` dengan target resolusi 1080p:
```bash
libreget download "<URL>" -q 1080 -o workspace/raw-video
```

Opsi tambahan yang didukung wrapper:
- `--audio-only` — unduh audio saja.
- `--subs id,en` — unduh subtitle bahasa tertentu.

### 3. Batch Download (`batch`)
Mengunduh banyak URL dari file teks (1 URL per baris) dengan batas konkurensi:
```bash
libreget batch links.txt -m 3
```

### 4. Import Cookies (`import-cookies`)
Untuk video privat atau butuh autentikasi (format Netscape `cookies.txt`):
```bash
libreget import-cookies cookies.txt
```

---

## Catatan Instalasi Binary

`./setup.sh --full` mengunduh binary rilis resmi `libreget-cli-<version>-<target>` dari GitHub Releases `OpenSelena/libreget` sesuai arsitektur (`x86_64` / `aarch64`) dan menyimpannya ke `bin/libreget`. Seluruh source frontend (`src/`, `src-tauri/`) tidak di-clone.
