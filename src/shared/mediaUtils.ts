import type { ClipRotation, ColorAdjust, OutputSettings, VideoItem } from "./types";
import { defaultColorAdjust } from "./types";
import { getDirectoryFromPath, getFilePath, joinPath, readFilePath } from "./sessionFile";

export {
  deriveStableClipId,
  getDirectoryFromPath,
  getFilePath,
  joinPath,
  readFilePath
} from "./sessionFile";

export const defaultOutputSettings: OutputSettings = {
  width: 1920,
  height: 1080,
  aspectLabel: "16:9 1080p",
  aspectHandling: "fit-blur",
  format: "mp4",
  fps: 30,
  quality: 60,
  masterVolume: 1,
  outputName: "merged-video"
};

/** Fill in defaults for settings loaded from older sessions/autosaves that predate the new fields. */
export function normalizeOutputSettings(settings: Partial<OutputSettings> | undefined): OutputSettings {
  const base = settings ?? {};
  const fps = Number(base.fps);
  const quality = Number(base.quality);
  const masterVolume = Number(base.masterVolume);
  return {
    ...defaultOutputSettings,
    ...base,
    fps: [24, 25, 30, 60].includes(fps) ? fps : defaultOutputSettings.fps,
    quality: Number.isFinite(quality) ? Math.min(100, Math.max(20, quality)) : defaultOutputSettings.quality,
    masterVolume: Number.isFinite(masterVolume) ? Math.min(2, Math.max(0, masterVolume)) : defaultOutputSettings.masterVolume,
    outputName:
      typeof base.outputName === "string" && base.outputName.trim().length > 0
        ? sanitizeOutputName(base.outputName)
        : defaultOutputSettings.outputName
  };
}

export function sanitizeOutputName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\.+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "merged-video";
}

export function createVideoId(file: File): string {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${file.name}-${file.lastModified}-${file.size}-${randomPart}`;
}

const SUPPORTED_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv"];
const SUPPORTED_MIME_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

export function isMp4File(file: File): boolean {
  return isSupportedVideoFile(file);
}

export function isSupportedVideoFile(file: File): boolean {
  return SUPPORTED_MIME_TYPES.includes(file.type) || SUPPORTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
}

export function validateVideoFiles(files: File[]): string[] {
  if (files.length === 0) {
    return ["Choose at least one video file."];
  }

  const invalidFiles = files.filter((file) => !isSupportedVideoFile(file));
  if (invalidFiles.length === 0) {
    return [];
  }

  return invalidFiles.map((file) => `${file.name} is not a supported video file (mp4, mov, webm, mkv).`);
}

export function sortByCreationDate(items: VideoItem[]): VideoItem[] {
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }

    return a.name.localeCompare(b.name);
  });
}

export function reorderItems<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (movedItem === undefined) {
    return items;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export function formatDuration(seconds?: number): string {
  if (!Number.isFinite(seconds)) {
    return "0:00";
  }

  const roundedSeconds = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function createVideoItem(file: File, path?: string): VideoItem {
  const resolvedPath = path ?? getFilePath(file);
  return {
    id: createVideoId(file),
    file,
    objectUrl: URL.createObjectURL(file),
    name: file.name,
    size: file.size,
    mimeType: file.type || "video/mp4",
    createdAt: file.lastModified,
    status: "queued",
    rotation: 0,
    volume: 1,
    muted: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    colorAdjust: { ...defaultColorAdjust },
    ...(resolvedPath ? { path: resolvedPath } : {})
  };
}

export function cloneVideoItem(item: VideoItem): VideoItem {
  return {
    ...item,
    id: createVideoId(item.file),
    objectUrl: URL.createObjectURL(item.file),
    previewUrl: item.previewUrl,
    colorAdjust: { ...item.colorAdjust },
    ...(item.textOverlay ? { textOverlay: { ...item.textOverlay } } : {}),
    locked: false
  };
}

export function clampVolume(value: number): number {
  return Math.min(2, Math.max(0, value));
}

export function clampSpeed(value: number): number {
  return Math.min(2, Math.max(0.5, value));
}

export function clampFade(value: number): number {
  return Math.min(30, Math.max(0, value));
}

export function clampColorAdjust(adjust: Partial<ColorAdjust>): ColorAdjust {
  return {
    brightness: Math.min(1, Math.max(-1, adjust.brightness ?? 0)),
    contrast: Math.min(3, Math.max(0, adjust.contrast ?? 1)),
    saturation: Math.min(3, Math.max(0, adjust.saturation ?? 1))
  };
}

export function hasColorAdjust(adjust: ColorAdjust): boolean {
  return adjust.brightness !== 0 || adjust.contrast !== 1 || adjust.saturation !== 1;
}

export function clampFreeze(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(30, Math.max(0, value));
}

export function clampCrossfade(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(5, Math.max(0, value));
}

/** Output duration of one clip after trim, speed and freeze-frame are applied. */
export function clipOutputDuration(item: {
  metadata?: { duration: number };
  trimSegments?: { start: number; end: number }[];
  speed: number;
  freezeFrame?: number;
}): number {
  const kept = item.trimSegments && item.trimSegments.length > 0
    ? item.trimSegments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0)
    : Math.max(0, item.metadata?.duration ?? 0);
  const speed = item.speed > 0 ? item.speed : 1;
  return kept / speed + Math.max(0, item.freezeFrame ?? 0);
}

/** Total composition duration accounting for crossfade overlaps between adjacent clips. */
export function totalCompositionDuration(
  items: Array<Parameters<typeof clipOutputDuration>[0] & { crossfadeAfter?: number }>
): number {
  let total = 0;
  items.forEach((item, index) => {
    total += clipOutputDuration(item);
    if (index < items.length - 1) {
      total -= Math.max(0, Math.min(item.crossfadeAfter ?? 0, 5));
    }
  });
  return Math.max(0, total);
}

/** Rough output size estimate in bytes: (video bitrate + audio bitrate) * duration. */
export function estimateOutputBytes(durationSeconds: number, videoBitrateKbps: number, audioBitrateKbps = 160): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  return Math.round(((videoBitrateKbps + audioBitrateKbps) * 1000) / 8 * durationSeconds);
}

export function buildClipsCsv(items: VideoItem[]): string {
  const header = "index,name,duration_seconds,effective_seconds,width,height,has_audio,size_bytes,speed,rotation_degrees";
  const escapeCsv = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = items.map((item, index) => {
    const duration = item.metadata?.duration ?? 0;
    return [
      index + 1,
      escapeCsv(item.name),
      duration.toFixed(3),
      clipOutputDuration(item).toFixed(3),
      item.metadata?.width ?? 0,
      item.metadata?.height ?? 0,
      item.metadata?.hasAudio ? "yes" : "no",
      item.size,
      item.speed,
      rotationDegrees(item.rotation)
    ].join(",");
  });
  return [header, ...rows].join("\n");
}

export function buildProjectSummary(items: VideoItem[], settings: OutputSettings): string {
  const lines = [
    `Video Merger project — ${items.length} clip${items.length === 1 ? "" : "s"}`,
    `Output: ${settings.width}x${settings.height} @ ${settings.fps}fps (${settings.aspectLabel}, ${settings.aspectHandling})`,
    `Total duration: ${formatDuration(totalCompositionDuration(items))}`,
    ""
  ];
  items.forEach((item, index) => {
    const extras: string[] = [];
    if (item.rotation !== 0) extras.push(`${rotationDegrees(item.rotation)}°`);
    if (item.trimSegments && item.trimSegments.length > 0) extras.push("trimmed");
    if (item.speed !== 1) extras.push(`${item.speed}x`);
    if (item.muted) extras.push("muted");
    if (item.reversed) extras.push("reversed");
    if (item.markerLabel) lines.push(`--- ${item.markerLabel} ---`);
    lines.push(
      `${String(index + 1).padStart(2, "0")}. ${item.name} (${formatDuration(clipOutputDuration(item))})${extras.length > 0 ? ` [${extras.join(", ")}]` : ""}`
    );
  });
  return lines.join("\n");
}

export function findDuplicateNames(existing: VideoItem[], incoming: File[]): string[] {
  const seen = new Set(existing.map((item) => `${item.name}::${item.size}`));
  const duplicates: string[] = [];
  for (const file of incoming) {
    const key = `${file.name}::${file.size}`;
    if (seen.has(key)) {
      duplicates.push(file.name);
    }
    seen.add(key);
  }
  return duplicates;
}

export function cycleClipRotation(rotation: ClipRotation): ClipRotation {
  return ((rotation + 1) % 4) as ClipRotation;
}

export function rotationDegrees(rotation: ClipRotation): number {
  return rotation * 90;
}

export function isTransposed(rotation: ClipRotation): boolean {
  return rotation % 2 === 1;
}
