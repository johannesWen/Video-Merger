export type AspectHandling = "fit-blur" | "center-crop" | "letterbox";
export type MergePhase = "idle" | "probing" | "normalizing" | "concatenating" | "complete" | "error";
export type ProcessingMode = "auto" | "backend" | "browser";
export type ClipRotation = 0 | 1 | 2 | 3;

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  aspectRatio: number;
  hasAudio: boolean;
}

export interface PreviewAsset {
  thumbnailUrl: string;
}

export interface TrimSegment {
  start: number;
  end: number;
}

export interface VideoItem {
  id: string;
  file: File;
  objectUrl: string;
  previewUrl?: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: number;
  metadata?: VideoMetadata;
  status: "queued" | "probing" | "ready" | "error";
  error?: string;
  rotation: ClipRotation;
  trimSegments?: TrimSegment[];
  path?: string;
}

export interface OutputSettings {
  width: number;
  height: number;
  aspectLabel: string;
  aspectHandling: AspectHandling;
  format: "mp4";
}

export interface MergeProgress {
  phase: MergePhase;
  completed: number;
  total: number;
  ratio: number;
  message: string;
}

export type MergeProgressCallback = (progress: MergeProgress) => void;

export const SESSION_FILE_VERSION = 1 as const;
export const SESSION_APP_NAME = "video-merger" as const;
export const SESSION_FILE_EXTENSION = ".videomerge.json";
export const SESSION_FILE_MIME = "application/json";

export interface SessionClip {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: number;
  path: string;
  rotation: ClipRotation;
  trimSegments?: TrimSegment[];
}

export interface SessionFile {
  version: typeof SESSION_FILE_VERSION;
  app: typeof SESSION_APP_NAME;
  savedAt: number;
  settings: OutputSettings;
  processingMode: ProcessingMode;
  clips: SessionClip[];
}

export interface ProcessingEngine {
  probe(file: File): Promise<VideoMetadata>;
  createPreview(file: File): Promise<PreviewAsset>;
  merge(items: VideoItem[], settings: OutputSettings, onProgress: MergeProgressCallback): Promise<Blob>;
  cancel(): void;
}
