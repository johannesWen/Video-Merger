import type {
  MergeExtras,
  MergePhase,
  MergeProgress,
  MergeProgressCallback,
  OutputSettings,
  PreviewAsset,
  ProcessingEngine,
  VideoItem,
  VideoMetadata
} from "../shared/types";
import { renderTextOverlayPng } from "../frontend/canvasUtils";

export interface BackendHealth {
  ok: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  mode: "backend";
}

const PROGRESS_RANGE = {
  uploadStart: 0.05,
  preparing: 0.1,
  encodingStart: 0.1,
  encodingEnd: 0.88,
  muxingStart: 0.88,
  muxingEnd: 0.92,
  receiving: 0.95
};

const ENCODING_SPAN = PROGRESS_RANGE.encodingEnd - PROGRESS_RANGE.encodingStart;
const MUXING_SPAN = PROGRESS_RANGE.muxingEnd - PROGRESS_RANGE.muxingStart;

export class BackendFfmpegEngine implements Pick<ProcessingEngine, "merge" | "cancel"> {
  private abortController: AbortController | null = null;
  private currentJobId: string | null = null;
  private currentEventSource: EventSource | null = null;

  async merge(items: VideoItem[], settings: OutputSettings, onProgress: MergeProgressCallback, extras?: MergeExtras): Promise<Blob> {
    if (items.length === 0) {
      throw new Error("Add at least one MP4 before generating.");
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const formData = new FormData();
    formData.set("settings", JSON.stringify(settings));
    formData.set("rotations", JSON.stringify(items.map((item) => item.rotation)));
    formData.set("trims", JSON.stringify(items.map((item) => item.trimSegments ?? null)));
    formData.set(
      "clipEffects",
      JSON.stringify(
        items.map((item) => ({
          volume: item.volume,
          muted: item.muted,
          speed: item.speed,
          fadeIn: item.fadeIn,
          fadeOut: item.fadeOut,
          colorAdjust: item.colorAdjust,
          reversed: item.reversed === true,
          freezeFrame: item.freezeFrame ?? 0,
          crossfadeAfter: item.crossfadeAfter ?? 0
        }))
      )
    );
    items.forEach((item) => formData.append("videos", item.file, item.name));

    // Text overlays are rendered to transparent PNGs in the browser so the native
    // ffmpeg pass burns in the exact same text rendering as the wasm engine.
    const overlayIndexes: number[] = [];
    for (const [index, item] of items.entries()) {
      if (item.textOverlay && item.textOverlay.text.trim().length > 0) {
        const png = await renderTextOverlayPng(item.textOverlay, settings.width, settings.height);
        formData.append("overlays", png, `overlay-${index}.png`);
        overlayIndexes.push(index);
      }
    }
    formData.set("overlayIndexes", JSON.stringify(overlayIndexes));

    if (extras?.watermark) {
      formData.append("watermark", extras.watermark.file, extras.watermark.file.name);
      formData.set("watermarkOpacity", String(extras.watermark.opacity));
      formData.set("watermarkPosition", extras.watermark.position);
      formData.set("watermarkScale", String(extras.watermark.scale));
    }
    if (extras?.backgroundMusic) {
      formData.append("music", extras.backgroundMusic.file, extras.backgroundMusic.file.name);
      formData.set("musicVolume", String(extras.backgroundMusic.volume));
    }

    onProgress({
      phase: "normalizing",
      completed: 0,
      total: items.length,
      ratio: PROGRESS_RANGE.uploadStart,
      message: "Uploading to backend FFmpeg"
    });

    let jobId: string;
    try {
      const response = await fetch("/api/merge", {
        method: "POST",
        body: formData,
        signal
      });
      if (!response.ok) {
        throw new Error(await readBackendError(response));
      }
      const body = (await response.json()) as { jobId?: string };
      if (!body.jobId) {
        throw new Error("Backend did not return a job id.");
      }
      jobId = body.jobId;
    } catch (error) {
      this.abortController = null;
      throw new Error(toMessage(error, "Backend merge failed."));
    }

    this.currentJobId = jobId;

    onProgress({
      phase: "normalizing",
      completed: 0,
      total: items.length,
      ratio: PROGRESS_RANGE.preparing,
      message: "Backend preparing"
    });

    try {
      const blob = await this.awaitMergeResult(jobId, items.length, onProgress, signal);
      onProgress({
        phase: "complete",
        completed: items.length,
        total: items.length,
        ratio: 1,
        message: "Backend merge complete"
      });
      return blob;
    } finally {
      this.cleanupJob();
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.closeEventSource();
    const jobId = this.currentJobId;
    this.currentJobId = null;
    if (jobId) {
      void fetch(`/api/merge/${jobId}`, { method: "DELETE" }).catch(() => {
        // Cancellation is best-effort; the server also reaps idle jobs via the TTL sweep.
      });
    }
  }

  private async awaitMergeResult(
    jobId: string,
    itemCount: number,
    onProgress: MergeProgressCallback,
    signal: AbortSignal
  ): Promise<Blob> {
    const result = await new Promise<Blob>((resolve, reject) => {
      const eventSource = new EventSource(`/api/merge/${jobId}/events`);
      this.currentEventSource = eventSource;

      const onAbort = () => {
        eventSource.close();
        reject(new DOMException("Merge cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const handleProgress = (event: MessageEvent<string>) => {
        const payload = parseProgressPayload(event.data);
        if (!payload) {
          return;
        }

        const phase: MergePhase = payload.phase === "muxing" ? "concatenating" : "normalizing";
        const ratio = payload.phase === "muxing"
          ? PROGRESS_RANGE.muxingStart + payload.ratio * MUXING_SPAN
          : PROGRESS_RANGE.encodingStart + payload.ratio * ENCODING_SPAN;

        onProgress({
          phase,
          completed: Math.min(itemCount, payload.currentClipIndex + (payload.phase === "encoding" ? 0 : 1)),
          total: itemCount,
          ratio: clamp(ratio, PROGRESS_RANGE.encodingStart, PROGRESS_RANGE.muxingEnd),
          message: payload.message
        });
      };

      const handleComplete = () => {
        signal.removeEventListener("abort", onAbort);
        eventSource.close();
        if (this.currentEventSource === eventSource) {
          this.currentEventSource = null;
        }

        onProgress({
          phase: "concatenating",
          completed: itemCount,
          total: itemCount,
          ratio: PROGRESS_RANGE.receiving,
          message: "Receiving merged MP4"
        });

        void (async () => {
          try {
            const resultResponse = await fetch(`/api/merge/${jobId}/result`, { signal });
            if (!resultResponse.ok) {
              reject(new Error(await readBackendError(resultResponse)));
              return;
            }
            const blob = await resultResponse.blob();
            resolve(blob);
          } catch (downloadError) {
            reject(toMessage(downloadError, "Failed to download merged video."));
          }
        })();
      };

      const handleError = (event: MessageEvent<string> | Event) => {
        signal.removeEventListener("abort", onAbort);
        eventSource.close();
        if (this.currentEventSource === eventSource) {
          this.currentEventSource = null;
        }

        const data = "data" in event && typeof event.data === "string" ? event.data : null;
        const parsed = data ? safeJsonParse(data) : null;
        const errorMessage = parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null;
        const message = errorMessage ?? data ?? "Lost connection to backend.";
        reject(new Error(message));
      };

      eventSource.addEventListener("progress", handleProgress);
      eventSource.addEventListener("status", handleProgress);
      eventSource.addEventListener("complete", handleComplete);
      eventSource.addEventListener("error", handleError as EventListener);

      eventSource.addEventListener("open", () => {
        if (signal.aborted) {
          onAbort();
        }
      });
    });

    return result;
  }

  private closeEventSource(): void {
    this.currentEventSource?.close();
    this.currentEventSource = null;
  }

  private cleanupJob(): void {
    this.closeEventSource();
    this.currentJobId = null;
  }
}

export async function getBackendHealth(): Promise<BackendHealth> {
  const response = await fetch("/api/health");

  if (!response.ok) {
    throw new Error("Backend health check failed.");
  }

  return (await response.json()) as BackendHealth;
}

interface ServerProgressPayload {
  ratio: number;
  phase: "encoding" | "muxing";
  currentClipIndex: number;
  clipCount: number;
  message: string;
}

function parseProgressPayload(rawData: string | null): ServerProgressPayload | null {
  if (!rawData) {
    return null;
  }
  const parsed = safeJsonParse(rawData);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const candidate = parsed as Partial<ServerProgressPayload>;
  if (typeof candidate.ratio !== "number" || typeof candidate.phase !== "string") {
    return null;
  }
  return {
    ratio: candidate.ratio,
    phase: candidate.phase,
    currentClipIndex: typeof candidate.currentClipIndex === "number" ? candidate.currentClipIndex : 0,
    clipCount: typeof candidate.clipCount === "number" ? candidate.clipCount : 0,
    message: typeof candidate.message === "string" ? candidate.message : ""
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readBackendError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Backend request failed (${response.status}).`;
  } catch {
    return `Backend request failed (${response.status}).`;
  }
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

// The backend engine only owns merging. Probing and previews stay in-browser for instant UI feedback.
export type BrowserProbeEngine = Pick<ProcessingEngine, "probe" | "createPreview"> & {
  probe(file: File): Promise<VideoMetadata>;
  createPreview(file: File): Promise<PreviewAsset>;
};
