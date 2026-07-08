export type AspectHandling = "fit-blur" | "center-crop" | "letterbox";
export type MergePhase = "idle" | "probing" | "normalizing" | "concatenating" | "complete" | "error";
export type ProcessingMode = "auto" | "backend" | "browser";
export type ClipRotation = 0 | 1 | 2 | 3;
export type Theme = "light" | "dark" | "high-contrast";
export type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

export type TextOverlayPosition = "top" | "center" | "bottom";

export interface TextOverlay {
  text: string;
  position: TextOverlayPosition;
  fontSize: number;
  color: string;
}

export interface ClipEffectsPreset {
  name: string;
  volume: number;
  muted: boolean;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  colorAdjust: ColorAdjust;
}

export interface ColorAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

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
  volume: number;
  muted: boolean;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  colorAdjust: ColorAdjust;
  /** Reverse playback of video+audio (ffmpeg reverse/areverse). */
  reversed?: boolean;
  /** Hold the last frame for this many seconds. */
  freezeFrame?: number;
  /** Burned-in text overlay. */
  textOverlay?: TextOverlay;
  /** Crossfade duration (seconds) into the NEXT clip. 0/undefined = hard cut. */
  crossfadeAfter?: number;
  /** Prevents remove/rotate/edit until unlocked. Organizational. */
  locked?: boolean;
  /** Color tag (CSS color) for organization. */
  tagColor?: string;
  /** Optional short text tag. */
  tagText?: string;
  /** Free-text note. Organizational only. */
  note?: string;
  /** Chapter/marker label shown before this clip in the list. */
  markerLabel?: string;
  /** Low-res audio waveform peaks (0..1), for card visualization. */
  waveform?: number[];
}

export const defaultColorAdjust: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 };

export interface WatermarkSettings {
  file: File;
  opacity: number;
  position: WatermarkPosition;
  scale: number;
}

export interface BackgroundMusicSettings {
  file: File;
  volume: number;
}

export interface MergeExtras {
  watermark?: WatermarkSettings;
  backgroundMusic?: BackgroundMusicSettings;
}

export interface OutputSettings {
  width: number;
  height: number;
  aspectLabel: string;
  aspectHandling: AspectHandling;
  format: "mp4";
  /** Output frame rate. */
  fps: number;
  /** Quality percent (20-100). Scales the target bitrate. */
  quality: number;
  /** Master output volume multiplier (0-2) applied to every clip's audio. */
  masterVolume: number;
  /** Base name (no extension) for downloaded merge/GIF results. */
  outputName: string;
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
  merge(
    items: VideoItem[],
    settings: OutputSettings,
    onProgress: MergeProgressCallback,
    extras?: MergeExtras
  ): Promise<Blob>;
  cancel(): void;
}
