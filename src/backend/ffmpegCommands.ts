import type { ClipRotation, OutputSettings, VideoMetadata } from "../shared/types";
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
}

export { buildIndexedAudioFilter, createRemuxSegmentsArgs, createSegmentArgs, getVideoBitrate };

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
