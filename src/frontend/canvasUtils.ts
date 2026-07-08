import { textOverlayYRatio } from "../processing/ffmpegSegments";
import type { TextOverlay, VideoItem } from "../shared/types";

/**
 * Renders a per-clip text/title overlay to a transparent PNG at the output resolution.
 * Both ffmpeg engines burn this in with a simple overlay filter, which keeps text
 * rendering identical between the wasm build (no fontconfig/drawtext fonts) and native ffmpeg.
 */
export async function renderTextOverlayPng(overlay: TextOverlay, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(width / 2) * 2);
  canvas.height = Math.max(2, Math.round(height / 2) * 2);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create overlay canvas.");
  }

  const fontSize = Math.max(10, Math.min(200, overlay.fontSize));
  context.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.shadowColor = "rgba(0, 0, 0, 0.65)";
  context.shadowBlur = Math.max(2, fontSize / 8);
  context.shadowOffsetY = Math.max(1, fontSize / 24);
  context.fillStyle = overlay.color;

  const x = canvas.width / 2;
  const y = Math.round(canvas.height * textOverlayYRatio(overlay.position));
  const lines = overlay.text.split("\n").slice(0, 4);
  const lineHeight = fontSize * 1.2;
  const blockOffset = ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    context.fillText(line, x, y - blockOffset + index * lineHeight, canvas.width * 0.94);
  });

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not render text overlay."));
      }
    }, "image/png");
  });
}

/** Captures a single frame from a video file at the requested time as a JPEG object URL. */
export async function captureFrameUrl(objectUrl: string, atSeconds: number): Promise<string> {
  const { canvas } = await captureFrameCanvas(objectUrl, atSeconds);
  return await new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("Could not capture the frame."))),
      "image/jpeg",
      0.85
    );
  });
}

async function captureFrameCanvas(
  objectUrl: string,
  atSeconds: number
): Promise<{ canvas: HTMLCanvasElement; duration: number }> {
  return await new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;
    let settled = false;

    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    };

    video.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(Math.max(0, atSeconds), Math.max(0, duration - 0.05));
    });
    video.addEventListener("seeked", () => {
      if (settled) {
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, video.videoWidth);
      canvas.height = Math.max(2, video.videoHeight);
      const context = canvas.getContext("2d");
      if (!context) {
        fail("Could not create capture canvas.");
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      settled = true;
      resolve({ canvas, duration: video.duration });
    });
    video.addEventListener("error", () => fail("Could not read the video for frame capture."));
  });
}

/**
 * Builds a contact-sheet PNG: a grid of frame thumbnails across all ready clips
 * (columns per clip, one row per clip), with clip names burned in.
 */
export async function buildContactSheet(items: VideoItem[], framesPerClip = 4, thumbWidth = 320): Promise<Blob> {
  const ready = items.filter((item) => item.status === "ready" && item.metadata);
  if (ready.length === 0) {
    throw new Error("No ready clips to build a contact sheet from.");
  }

  const labelHeight = 22;
  const rows: Array<{ name: string; frames: HTMLCanvasElement[] }> = [];
  let thumbHeight = Math.round((thumbWidth * 9) / 16);

  for (const item of ready) {
    const duration = item.metadata?.duration ?? 0;
    const frames: HTMLCanvasElement[] = [];
    for (let index = 0; index < framesPerClip; index += 1) {
      const at = duration * ((index + 0.5) / framesPerClip);
      try {
        const { canvas } = await captureFrameCanvas(item.objectUrl, at);
        frames.push(canvas);
      } catch {
        // Skip unreadable frames rather than failing the whole sheet.
      }
    }
    if (frames.length > 0) {
      const ratio = frames[0].height / frames[0].width;
      thumbHeight = Math.max(thumbHeight, Math.round(thumbWidth * Math.min(ratio, 1.4)));
      rows.push({ name: item.name, frames });
    }
  }

  if (rows.length === 0) {
    throw new Error("Could not capture any frames for the contact sheet.");
  }

  const padding = 8;
  const sheet = document.createElement("canvas");
  sheet.width = padding + framesPerClip * (thumbWidth + padding);
  sheet.height = padding + rows.length * (thumbHeight + labelHeight + padding);
  const context = sheet.getContext("2d");
  if (!context) {
    throw new Error("Could not create contact sheet canvas.");
  }

  context.fillStyle = "#101318";
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.font = "600 13px system-ui, sans-serif";
  context.textBaseline = "middle";

  rows.forEach((row, rowIndex) => {
    const top = padding + rowIndex * (thumbHeight + labelHeight + padding);
    context.fillStyle = "#e8ecf2";
    context.fillText(row.name, padding, top + labelHeight / 2, sheet.width - padding * 2);
    row.frames.forEach((frame, colIndex) => {
      const left = padding + colIndex * (thumbWidth + padding);
      const scale = Math.min(thumbWidth / frame.width, thumbHeight / frame.height);
      const w = frame.width * scale;
      const h = frame.height * scale;
      context.fillStyle = "#000";
      context.fillRect(left, top + labelHeight, thumbWidth, thumbHeight);
      context.drawImage(frame, left + (thumbWidth - w) / 2, top + labelHeight + (thumbHeight - h) / 2, w, h);
    });
  });

  return await new Promise<Blob>((resolve, reject) => {
    sheet.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not render the contact sheet."))), "image/png");
  });
}

let sharedAudioContext: AudioContext | null = null;

/** Decodes a clip's audio and returns low-res normalized peaks for waveform display. Returns [] on failure/no audio. */
export async function computeWaveformPeaks(file: File, buckets = 96): Promise<number[]> {
  try {
    const AudioContextCtor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return [];
    }
    sharedAudioContext = sharedAudioContext ?? new AudioContextCtor();
    const buffer = await file.arrayBuffer();
    const audio = await sharedAudioContext.decodeAudioData(buffer);
    const channel = audio.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(channel.length / buckets));
    const peaks: number[] = [];
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * bucketSize;
      let peak = 0;
      const end = Math.min(channel.length, start + bucketSize);
      for (let index = start; index < end; index += 47) {
        const value = Math.abs(channel[index]);
        if (value > peak) {
          peak = value;
        }
      }
      peaks.push(peak);
    }
    const max = Math.max(0.001, ...peaks);
    return peaks.map((peak) => peak / max);
  } catch {
    return [];
  }
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
