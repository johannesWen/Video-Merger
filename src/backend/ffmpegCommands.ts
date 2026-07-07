import type { ClipRotation, ColorAdjust, OutputSettings, TrimSegment, VideoMetadata } from "../shared/types";
import { defaultColorAdjust } from "../shared/types";
import {
  buildIndexedAudioFilter,
  createRemuxSegmentsArgs,
  createSegmentArgs,
  getVideoBitrate
} from "../processing/ffmpegSegments";

export interface BackendClip {
  inputPath: string;
  metadata: VideoMetadata;
  rotation: ClipRotation;
  trimSegments?: TrimSegment[];
  volume: number;
  muted: boolean;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  colorAdjust: ColorAdjust;
}

export interface ClipEffects {
  volume: number;
  muted: boolean;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  colorAdjust: ColorAdjust;
}

export function parseClipEffects(rawEffects: unknown, length: number): ClipEffects[] {
  const fallback = (): ClipEffects[] =>
    Array.from({ length }, () => ({
      volume: 1,
      muted: false,
      speed: 1,
      fadeIn: 0,
      fadeOut: 0,
      colorAdjust: { ...defaultColorAdjust }
    }));

  if (typeof rawEffects !== "string" || length === 0) {
    return fallback();
  }

  try {
    const parsed = JSON.parse(rawEffects) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== length) {
      return fallback();
    }
    return parsed.map((value) => normalizeClipEffects(value));
  } catch {
    return fallback();
  }
}

function normalizeClipEffects(value: unknown): ClipEffects {
  const entry = (value && typeof value === "object" ? value : {}) as Partial<ClipEffects>;
  const colorAdjustRaw = (entry.colorAdjust ?? {}) as Partial<ColorAdjust>;

  return {
    volume: clampNumber(entry.volume, 0, 2, 1),
    muted: entry.muted === true,
    speed: clampNumber(entry.speed, 0.5, 2, 1),
    fadeIn: clampNumber(entry.fadeIn, 0, 30, 0),
    fadeOut: clampNumber(entry.fadeOut, 0, 30, 0),
    colorAdjust: {
      brightness: clampNumber(colorAdjustRaw.brightness, -1, 1, 0),
      contrast: clampNumber(colorAdjustRaw.contrast, 0, 3, 1),
      saturation: clampNumber(colorAdjustRaw.saturation, 0, 3, 1)
    }
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

export { buildIndexedAudioFilter, createRemuxSegmentsArgs, createSegmentArgs, getVideoBitrate };

export function parseTrimSegments(rawTrims: unknown, length: number): Array<TrimSegment[] | undefined> {
  const fallback = (): Array<TrimSegment[] | undefined> => Array.from({ length }, () => undefined);

  if (typeof rawTrims !== "string" || length === 0) {
    return fallback();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTrims);
  } catch {
    return fallback();
  }

  if (!Array.isArray(parsed) || parsed.length !== length) {
    return fallback();
  }

  return parsed.map((value) => normalizeTrimSegments(value));
}

function normalizeTrimSegments(value: unknown): TrimSegment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const result: TrimSegment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const start = Number((entry as { start?: unknown }).start);
    const end = Number((entry as { end?: unknown }).end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }
    result.push({ start: Math.max(0, start), end });
  }

  return result.length > 0 ? result : undefined;
}

export function buildProbeArgs(inputPath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

export function parseProbeOutput(rawOutput: string): VideoMetadata {
  const info = JSON.parse(rawOutput) as FfprobeResult;
  const videoStream = info.streams.find((stream) => stream.codec_type === "video");
  const hasAudio = info.streams.some((stream) => stream.codec_type === "audio");
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;
  const duration = Number(videoStream?.duration ?? info.format.duration ?? 0);

  return {
    duration,
    width,
    height,
    aspectRatio: width > 0 && height > 0 ? width / height : 0,
    hasAudio
  };
}

export interface FfmpegProgressUpdate {
  currentTimeUs?: number;
  done: boolean;
}

export function parseFfmpegProgressLine(line: string): FfmpegProgressUpdate {
  const trimmed = line.trim();

  if (trimmed === "progress=continue") {
    return { done: false };
  }

  if (trimmed === "progress=end") {
    return { done: true };
  }

  if (trimmed.startsWith("out_time_us=")) {
    const value = Number.parseInt(trimmed.slice("out_time_us=".length), 10);
    return Number.isFinite(value) ? { currentTimeUs: value, done: false } : { done: false };
  }

  if (trimmed.startsWith("out_time=")) {
    const value = parseOutTime(trimmed.slice("out_time=".length));
    return value !== undefined ? { currentTimeUs: value, done: false } : { done: false };
  }

  return { done: false };
}

function parseOutTime(rawValue: string): number | undefined {
  if (rawValue === "N/A" || rawValue.length === 0) {
    return undefined;
  }

  const match = rawValue.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    return undefined;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fractionDigits = match[4] ?? "0";
  const fraction = fractionDigits.length > 0 ? Number(`0.${fractionDigits}`) : 0;

  if (![hours, minutes, seconds, fraction].every((n) => Number.isFinite(n))) {
    return undefined;
  }

  const totalSeconds = hours * 3600 + minutes * 60 + seconds + fraction;
  return Math.round(totalSeconds * 1_000_000);
}

export function formatFfmpegTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00:00";
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

export function progressRatio(currentTimeUs: number, totalDurationSeconds: number): number {
  if (!Number.isFinite(currentTimeUs) || !Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0) {
    return 0;
  }

  const ratio = currentTimeUs / 1_000_000 / totalDurationSeconds;
  if (!Number.isFinite(ratio) || ratio < 0) {
    return 0;
  }

  return ratio > 1 ? 1 : ratio;
}

interface FfprobeResult {
  streams: Array<{
    codec_type: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format: {
    duration?: string;
  };
}
