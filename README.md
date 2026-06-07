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

## Getting Started

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The dev server sets the COOP/COEP headers needed by browser WebAssembly workers.

## Scripts

```bash
npm run dev
npm run build
npm run test
```

## Implementation Notes

- The browser processing adapter lives in `src/processing/BrowserFfmpegEngine.ts`.
- Public media types and output settings live in `src/shared/types.ts`.
- The UI lives in `src/frontend`.
- The processing engine interface is intentionally small so a backend FFmpeg fallback can be added later.
- Clips without audio receive a silent AAC track before concatenation so mixed audio/no-audio projects can still merge.
