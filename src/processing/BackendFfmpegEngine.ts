import type {
  MergeProgressCallback,
  OutputSettings,
  PreviewAsset,
  ProcessingEngine,
  VideoItem,
  VideoMetadata
} from "../shared/types";

export interface BackendHealth {
  ok: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  mode: "backend";
}

export class BackendFfmpegEngine implements Pick<ProcessingEngine, "merge" | "cancel"> {
  private abortController: AbortController | null = null;

  async merge(items: VideoItem[], settings: OutputSettings, onProgress: MergeProgressCallback): Promise<Blob> {
    if (items.length === 0) {
      throw new Error("Add at least one MP4 before generating.");
    }

    this.abortController = new AbortController();
    const formData = new FormData();
    formData.set("settings", JSON.stringify(settings));
    formData.set("rotations", JSON.stringify(items.map((item) => item.rotation)));
    items.forEach((item) => formData.append("videos", item.file, item.name));

    onProgress({
      phase: "normalizing",
      completed: 0,
      total: items.length,
      ratio: 0.05,
      message: "Uploading to backend FFmpeg"
    });

    const response = await fetch("/api/merge", {
      method: "POST",
      body: formData,
      signal: this.abortController.signal
    });

    if (!response.ok) {
      throw new Error(await readBackendError(response));
    }

    onProgress({
      phase: "concatenating",
      completed: items.length,
      total: items.length,
      ratio: 0.92,
      message: "Receiving merged MP4"
    });

    const blob = await response.blob();
    this.abortController = null;

    onProgress({
      phase: "complete",
      completed: items.length,
      total: items.length,
      ratio: 1,
      message: "Backend merge complete"
    });

    return blob;
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}

export async function getBackendHealth(): Promise<BackendHealth> {
  const response = await fetch("/api/health");

  if (!response.ok) {
    throw new Error("Backend health check failed.");
  }

  return (await response.json()) as BackendHealth;
}

async function readBackendError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? "Backend merge failed.";
  } catch {
    return "Backend merge failed.";
  }
}

// The backend engine only owns merging. Probing and previews stay in-browser for instant UI feedback.
export type BrowserProbeEngine = Pick<ProcessingEngine, "probe" | "createPreview"> & {
  probe(file: File): Promise<VideoMetadata>;
  createPreview(file: File): Promise<PreviewAsset>;
};
