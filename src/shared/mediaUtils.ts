import type { ClipRotation, OutputSettings, VideoItem } from "./types";

export const defaultOutputSettings: OutputSettings = {
  width: 1920,
  height: 1080,
  aspectLabel: "16:9 1080p",
  aspectHandling: "fit-blur",
  format: "mp4"
};

export function createVideoId(file: File): string {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${file.name}-${file.lastModified}-${file.size}-${randomPart}`;
}

export function isMp4File(file: File): boolean {
  return file.type === "video/mp4" || /\.mp4$/i.test(file.name);
}

export function validateVideoFiles(files: File[]): string[] {
  if (files.length === 0) {
    return ["Choose at least one MP4 file."];
  }

  const invalidFiles = files.filter((file) => !isMp4File(file));
  if (invalidFiles.length === 0) {
    return [];
  }

  return invalidFiles.map((file) => `${file.name} is not an MP4 file.`);
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

export function createVideoItem(file: File): VideoItem {
  return {
    id: createVideoId(file),
    file,
    objectUrl: URL.createObjectURL(file),
    name: file.name,
    size: file.size,
    mimeType: file.type || "video/mp4",
    createdAt: file.lastModified,
    status: "queued",
    rotation: 0
  };
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
