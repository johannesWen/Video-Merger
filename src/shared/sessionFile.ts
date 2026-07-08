import { isPristine } from "./trimSegments";
import {
  SESSION_APP_NAME,
  SESSION_FILE_MIME,
  SESSION_FILE_VERSION,
  type ClipRotation,
  type OutputSettings,
  type ProcessingMode,
  type SessionClip,
  type SessionFile,
  type TrimSegment,
  type VideoItem
} from "./types";

const TIME_PRECISION = 3;
const ALLOWED_ROTATIONS: readonly ClipRotation[] = [0, 1, 2, 3];
const ALLOWED_PROCESSING_MODES: readonly ProcessingMode[] = ["auto", "backend", "browser"];
const ALLOWED_ASPECT_HANDLINGS = ["fit-blur", "center-crop", "letterbox"] as const;

export interface PickedFile {
  file: File;
  path?: string;
}

export class SessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionValidationError";
  }
}

export function getFilePath(file: File): string {
  const fileWithPath = file as File & { path?: string };
  if (typeof fileWithPath.path === "string" && fileWithPath.path.length > 0) {
    return fileWithPath.path;
  }

  const fileWithRelative = file as File & { webkitRelativePath?: string };
  if (typeof fileWithRelative.webkitRelativePath === "string" && fileWithRelative.webkitRelativePath.length > 0) {
    return fileWithRelative.webkitRelativePath;
  }

  return file.name;
}

export function readFilePath(file: File): string | undefined {
  const fileWithPath = file as File & { path?: string };
  if (typeof fileWithPath.path === "string" && fileWithPath.path.length > 0) {
    return fileWithPath.path;
  }

  const fileWithRelative = file as File & { webkitRelativePath?: string };
  if (typeof fileWithRelative.webkitRelativePath === "string" && fileWithRelative.webkitRelativePath.length > 0) {
    return fileWithRelative.webkitRelativePath;
  }

  return undefined;
}

export function getDirectoryFromPath(absolutePath: string): string | undefined {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    return undefined;
  }
  const lastSlash = absolutePath.lastIndexOf("/");
  const lastBackslash = absolutePath.lastIndexOf("\\");
  const separatorIndex = Math.max(lastSlash, lastBackslash);
  if (separatorIndex <= 0) {
    return undefined;
  }
  return absolutePath.slice(0, separatorIndex);
}

export function getBaseNameFromPath(absolutePath: string): string | undefined {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    return undefined;
  }
  const lastSlash = absolutePath.lastIndexOf("/");
  const lastBackslash = absolutePath.lastIndexOf("\\");
  const separatorIndex = Math.max(lastSlash, lastBackslash);
  if (separatorIndex < 0) {
    return absolutePath;
  }
  return absolutePath.slice(separatorIndex + 1);
}

export function joinPath(directory: string, fileName: string): string {
  if (directory.length === 0) {
    return fileName;
  }
  const trailing = directory.slice(-1);
  if (trailing === "/" || trailing === "\\") {
    return `${directory}${fileName}`;
  }
  return `${directory}/${fileName}`;
}

export function deriveStableClipId(name: string, lastModified: number, size: number): string {
  return `${name}-${lastModified}-${size}`;
}

export function roundTime(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** TIME_PRECISION;
  return Math.round(value * factor) / factor;
}

export function serializeSession(
  items: VideoItem[],
  settings: OutputSettings,
  processingMode: ProcessingMode
): SessionFile {
  const clips: SessionClip[] = items.map((item) => {
    const storedPath = typeof item.path === "string" && item.path.length > 0 ? item.path : getFilePath(item.file);
    const clip: SessionClip = {
      id: deriveStableClipId(item.name, item.createdAt, item.size),
      name: item.name,
      size: item.size,
      mimeType: item.mimeType,
      createdAt: item.createdAt,
      path: storedPath,
      rotation: item.rotation
    };

    const duration = item.metadata?.duration ?? 0;
    if (item.trimSegments && item.trimSegments.length > 0) {
      const normalized = !isPristine(item.trimSegments, duration)
        ? item.trimSegments.map((segment) => ({ start: roundTime(segment.start), end: roundTime(segment.end) }))
        : undefined;
      if (normalized) {
        clip.trimSegments = normalized;
      }
    }

    return clip;
  });

  return {
    version: SESSION_FILE_VERSION,
    app: SESSION_APP_NAME,
    savedAt: Date.now(),
    settings: { ...settings },
    processingMode,
    clips
  };
}

export function parseSession(raw: string): SessionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SessionValidationError(`Session file is not valid JSON: ${(error as Error).message}`);
  }

  return validateSession(parsed);
}

export function validateSession(value: unknown): SessionFile {
  if (!isPlainObject(value)) {
    throw new SessionValidationError("Session root must be an object.");
  }

  if (value.app !== SESSION_APP_NAME) {
    throw new SessionValidationError(`Session file is not a ${SESSION_APP_NAME} session (app=${String(value.app)}).`);
  }

  if (value.version !== SESSION_FILE_VERSION) {
    throw new SessionValidationError(
      `Unsupported session version ${String(value.version)}. Expected ${SESSION_FILE_VERSION}.`
    );
  }

  const settings = validateSettings(value.settings);
  const processingMode = validateProcessingMode(value.processingMode);
  const clips = validateClips(value.clips);

  return {
    version: SESSION_FILE_VERSION,
    app: SESSION_APP_NAME,
    savedAt: validateNumber(value.savedAt, "savedAt"),
    settings,
    processingMode,
    clips
  };
}

export function sessionFileBlob(session: SessionFile): Blob {
  return new Blob([JSON.stringify(session, null, 2)], { type: SESSION_FILE_MIME });
}

function validateSettings(value: unknown): OutputSettings {
  if (!isPlainObject(value)) {
    throw new SessionValidationError("Session settings must be an object.");
  }

  const width = validateNumber(value.width, "settings.width");
  const height = validateNumber(value.height, "settings.height");
  if (width <= 0 || height <= 0) {
    throw new SessionValidationError("Session settings width/height must be positive.");
  }

  const aspectLabel = validateString(value.aspectLabel, "settings.aspectLabel");
  const aspectHandling = validateString(value.aspectHandling, "settings.aspectHandling");
  if (!ALLOWED_ASPECT_HANDLINGS.includes(aspectHandling as (typeof ALLOWED_ASPECT_HANDLINGS)[number])) {
    throw new SessionValidationError(`Session settings.aspectHandling is invalid: ${aspectHandling}`);
  }

  const fpsRaw = Number(value.fps);
  const qualityRaw = Number(value.quality);
  const masterVolumeRaw = Number(value.masterVolume);

  return {
    width,
    height,
    aspectLabel,
    aspectHandling: aspectHandling as OutputSettings["aspectHandling"],
    format: "mp4",
    fps: [24, 25, 30, 60].includes(fpsRaw) ? fpsRaw : 30,
    quality: Number.isFinite(qualityRaw) ? Math.min(100, Math.max(20, qualityRaw)) : 60,
    masterVolume: Number.isFinite(masterVolumeRaw) ? Math.min(2, Math.max(0, masterVolumeRaw)) : 1,
    outputName:
      typeof value.outputName === "string" && value.outputName.trim().length > 0 ? value.outputName : "merged-video"
  };
}

function validateProcessingMode(value: unknown): ProcessingMode {
  if (typeof value !== "string" || !ALLOWED_PROCESSING_MODES.includes(value as ProcessingMode)) {
    throw new SessionValidationError(`Session processingMode is invalid: ${String(value)}`);
  }
  return value as ProcessingMode;
}

function validateClips(value: unknown): SessionClip[] {
  if (!Array.isArray(value)) {
    throw new SessionValidationError("Session clips must be an array.");
  }

  return value.map((entry, index) => validateClip(entry, index));
}

function validateClip(value: unknown, index: number): SessionClip {
  if (!isPlainObject(value)) {
    throw new SessionValidationError(`Session clip #${index + 1} must be an object.`);
  }

  const id = validateString(value.id, `clips[${index}].id`);
  const name = validateString(value.name, `clips[${index}].name`);
  const size = validateNumber(value.size, `clips[${index}].size`);
  const mimeType = validateString(value.mimeType, `clips[${index}].mimeType`);
  const createdAt = validateNumber(value.createdAt, `clips[${index}].createdAt`);
  const path = validateString(value.path, `clips[${index}].path`);
  const rotation = validateNumber(value.rotation, `clips[${index}].rotation`);
  if (!ALLOWED_ROTATIONS.includes(rotation as ClipRotation)) {
    throw new SessionValidationError(`clips[${index}].rotation is invalid: ${rotation}`);
  }

  const trimSegments = value.trimSegments === undefined ? undefined : validateTrimSegments(value.trimSegments, index);

  return {
    id,
    name,
    size,
    mimeType,
    createdAt,
    path,
    rotation: rotation as ClipRotation,
    trimSegments
  };
}

function validateTrimSegments(value: unknown, index: number): TrimSegment[] {
  if (!Array.isArray(value)) {
    throw new SessionValidationError(`clips[${index}].trimSegments must be an array.`);
  }
  return value.map((entry, segmentIndex) => {
    if (!isPlainObject(entry)) {
      throw new SessionValidationError(`clips[${index}].trimSegments[${segmentIndex}] must be an object.`);
    }
    const start = validateNumber(entry.start, `clips[${index}].trimSegments[${segmentIndex}].start`);
    const end = validateNumber(entry.end, `clips[${index}].trimSegments[${segmentIndex}].end`);
    if (end < start) {
      throw new SessionValidationError(
        `clips[${index}].trimSegments[${segmentIndex}].end (${end}) is before start (${start}).`
      );
    }
    return { start, end };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SessionValidationError(`${label} must be a finite number.`);
  }
  return value;
}
