export type AspectHandling = "fit-blur" | "center-crop" | "letterbox";
export type MergePhase = "idle" | "probing" | "normalizing" | "concatenating" | "complete" | "error";
export type ProcessingMode = "auto" | "backend" | "browser";

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

export interface ProcessingEngine {
  probe(file: File): Promise<VideoMetadata>;
  createPreview(file: File): Promise<PreviewAsset>;
  merge(items: VideoItem[], settings: OutputSettings, onProgress: MergeProgressCallback): Promise<Blob>;
  cancel(): void;
}
