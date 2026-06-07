# Video Merger

A browser-first MP4 merger built with Vite, React, TypeScript, `@dnd-kit`, and `ffmpeg.wasm`.

## Features

- Upload or drop multiple `.mp4` files.
- Sort clips automatically by the file timestamp from `File.lastModified`.
- Inspect each clip for duration, resolution, aspect ratio, and audio stream.
- Preview clips in a sortable timeline.
- Reorder clips manually with mouse or keyboard-friendly drag and drop.
- Generate one downloadable MP4 in the selected output ratio.
- Preserve mismatched source frames with a blurred background fit by default.
- Keep video files local to the browser during processing.
- Use native backend FFmpeg automatically for larger projects when available.

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. `npm run dev` starts:

- Backend API: `http://localhost:5174`
- Frontend app: `http://localhost:5173`

The frontend dev server sets the COOP/COEP headers needed by browser WebAssembly workers and proxies `/api` to the backend.

## Backend FFmpeg

Install native `ffmpeg` and `ffprobe` for the faster backend path:

```bash
sudo apt install ffmpeg
```

The app starts in Hybrid mode. Hybrid uses backend FFmpeg when it is available and the project is large enough, otherwise it falls back to browser FFmpeg. You can also force Backend or Browser mode from the Engine control.

## Scripts

```bash
npm run dev
npm run dev:backend
npm run dev:frontend
npm run build
npm run test
```

## Implementation Notes

- The browser processing adapter lives in `src/processing/BrowserFfmpegEngine.ts`.
- The backend processing API lives in `src/backend`.
- Public media types and output settings live in `src/shared/types.ts`.
- The UI lives in `src/frontend`.
- The processing engine interface stays small so Browser and Backend merge engines can be selected without changing the UI workflow.
- Clips without audio receive a silent AAC track before concatenation so mixed audio/no-audio projects can still merge.
