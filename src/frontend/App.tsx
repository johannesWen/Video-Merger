import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Download,
  FileVideo,
  GripVertical,
  Loader2,
  RotateCcw,
  Scissors,
  Server,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackendFfmpegEngine, getBackendHealth } from "../processing/BackendFfmpegEngine";
import { BrowserFfmpegEngine } from "../processing/BrowserFfmpegEngine";
import {
  createVideoItem,
  defaultOutputSettings,
  formatBytes,
  formatDate,
  formatDuration,
  sortByCreationDate,
  validateVideoFiles
} from "../shared/mediaUtils";
import type { AspectHandling, MergeProgress, OutputSettings, ProcessingMode, VideoItem } from "../shared/types";

type AppStatus = "idle" | "probing" | "ready" | "merging" | "complete" | "error";

const aspectPresets = [
  { label: "16:9 720p", width: 1280, height: 720 },
  { label: "16:9 1080p", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 }
];

const aspectHandlingLabels: Record<AspectHandling, string> = {
  "fit-blur": "Blur fit",
  "center-crop": "Center crop",
  letterbox: "Bars"
};

export function App() {
  const browserEngine = useMemo(() => new BrowserFfmpegEngine(), []);
  const backendEngine = useMemo(() => new BackendFfmpegEngine(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<VideoItem[]>([]);
  const downloadUrlRef = useRef<string | null>(null);
  const [items, setItems] = useState<VideoItem[]>([]);
  const [settings, setSettings] = useState<OutputSettings>(defaultOutputSettings);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [progress, setProgress] = useState<MergeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("auto");
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [backendMessage, setBackendMessage] = useState("Checking backend");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const readyCount = items.filter((item) => item.status === "ready").length;
  const hasBlockingItem = items.some((item) => item.status === "probing" || item.status === "error");
  const canGenerate = items.length > 0 && readyCount === items.length && status !== "merging";

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    downloadUrlRef.current = downloadUrl;
  }, [downloadUrl]);

  useEffect(() => {
    return () => {
      itemsRef.current.forEach(revokeItemUrls);
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
      browserEngine.cancel();
      backendEngine.cancel();
    };
  }, [backendEngine, browserEngine]);

  useEffect(() => {
    let isCurrent = true;

    getBackendHealth()
      .then((health) => {
        if (!isCurrent) {
          return;
        }

        setBackendAvailable(health.ok);
        setBackendMessage(health.ok ? "Backend FFmpeg ready" : "Install ffmpeg and ffprobe for backend mode");
      })
      .catch(() => {
        if (!isCurrent) {
          return;
        }

        setBackendAvailable(false);
        setBackendMessage("Backend server unavailable");
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  const resetDownload = useCallback(() => {
    setDownloadUrl((currentUrl) => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
      return null;
    });
  }, []);

  const ingestFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      const messages = validateVideoFiles(files);
      const validFiles = files.filter((file) => messages.every((message) => !message.startsWith(file.name)));

      setError(messages.length > 0 ? messages.join(" ") : null);

      if (validFiles.length === 0) {
        return;
      }

      resetDownload();
      setStatus("probing");

      const queuedItems = sortByCreationDate(validFiles.map(createVideoItem));
      setItems((currentItems) => sortByCreationDate([...currentItems, ...queuedItems]));

      await Promise.all(
        queuedItems.map(async (item) => {
          setItems((currentItems) =>
            currentItems.map((currentItem) =>
              currentItem.id === item.id ? { ...currentItem, status: "probing" } : currentItem
            )
          );

          try {
            const [metadata, preview] = await Promise.all([browserEngine.probe(item.file), browserEngine.createPreview(item.file)]);
            setItems((currentItems) =>
              currentItems.map((currentItem) =>
                currentItem.id === item.id
                  ? {
                      ...currentItem,
                      metadata,
                      previewUrl: preview.thumbnailUrl,
                      status: "ready"
                    }
                  : currentItem
              )
            );
          } catch (probeError) {
            setItems((currentItems) =>
              currentItems.map((currentItem) =>
                currentItem.id === item.id
                  ? {
                      ...currentItem,
                      status: "error",
                      error: probeError instanceof Error ? probeError.message : "Could not inspect video."
                    }
                  : currentItem
              )
            );
          }
        })
      );

      setStatus((currentStatus) => (currentStatus === "probing" ? "ready" : currentStatus));
    },
    [browserEngine, resetDownload]
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      void ingestFiles(event.target.files);
      event.target.value = "";
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void ingestFiles(event.dataTransfer.files);
  };

  const handleRemove = (id: string) => {
    resetDownload();
    setItems((currentItems) => {
      const removedItem = currentItems.find((item) => item.id === id);
      if (removedItem) {
        revokeItemUrls(removedItem);
      }

      return currentItems.filter((item) => item.id !== id);
    });
  };

  const handleClear = () => {
    resetDownload();
    setError(null);
    setProgress(null);
    setStatus("idle");
    setItems((currentItems) => {
      currentItems.forEach(revokeItemUrls);
      return [];
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    resetDownload();
    setItems((currentItems) => {
      const oldIndex = currentItems.findIndex((item) => item.id === active.id);
      const newIndex = currentItems.findIndex((item) => item.id === over.id);

      return arrayMove(currentItems, oldIndex, newIndex);
    });
  };

  const handleGenerate = async () => {
    if (!canGenerate) {
      return;
    }

    resetDownload();
    setError(null);
    setStatus("merging");
    setProgress({
      phase: "normalizing",
      completed: 0,
      total: items.length,
      ratio: 0,
      message: "Starting"
    });

    try {
      const selectedEngine = chooseMergeEngine({
        browserEngine,
        backendEngine,
        backendAvailable,
        items,
        processingMode
      });
      const engineLabel = selectedEngine === backendEngine ? "Backend FFmpeg" : "Browser FFmpeg";

      setProgress({
        phase: "normalizing",
        completed: 0,
        total: items.length,
        ratio: 0,
        message: `Starting ${engineLabel}`
      });

      const blob = await selectedEngine.merge(items, settings, setProgress);
      setDownloadUrl(URL.createObjectURL(blob));
      setStatus("complete");
    } catch (mergeError) {
      setStatus("error");
      setError(getErrorMessage(mergeError, "Could not generate the merged video."));
    }
  };

  const handleCancel = () => {
    browserEngine.cancel();
    backendEngine.cancel();
    setStatus(items.length > 0 ? "ready" : "idle");
    setProgress(null);
    setError("Merge cancelled.");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Scissors aria-hidden="true" size={20} />
          </div>
          <div>
            <h1>Video Merger</h1>
            <p>{items.length === 0 ? "No clips loaded" : `${items.length} clips / ${readyCount} ready`}</p>
          </div>
        </div>

        <OutputControls
          settings={settings}
          processingMode={processingMode}
          backendAvailable={backendAvailable}
          onProcessingModeChange={setProcessingMode}
          onChange={setSettings}
          disabled={status === "merging"}
        />
      </header>

      <section className="workspace">
        <section className="timeline-panel" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
          {items.length === 0 ? (
            <button className="dropzone" type="button" onClick={() => fileInputRef.current?.click()}>
              <UploadCloud aria-hidden="true" size={34} />
              <span>Drop MP4 files</span>
              <small>or choose from disk</small>
            </button>
          ) : (
            <>
              <div className="timeline-toolbar">
                <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                  <UploadCloud aria-hidden="true" size={17} />
                  Add
                </button>
                <button className="icon-button" type="button" onClick={handleClear} title="Clear clips" aria-label="Clear clips">
                  <RotateCcw aria-hidden="true" size={18} />
                </button>
              </div>

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                  <ol className="clip-list">
                    {items.map((item, index) => (
                      <SortableClipCard key={item.id} item={item} index={index} onRemove={handleRemove} />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </>
          )}

          <input ref={fileInputRef} type="file" accept="video/mp4,.mp4" multiple hidden onChange={handleFileChange} />
        </section>

        <aside className="merge-panel">
          <div className="merge-meter" aria-live="polite">
            <span>{statusLabel(status, hasBlockingItem)}</span>
            <strong>{progress ? `${Math.round(progress.ratio * 100)}%` : `${readyCount}/${items.length}`}</strong>
            <div className="progress-track">
              <div style={{ width: `${progress ? progress.ratio * 100 : items.length === 0 ? 0 : (readyCount / items.length) * 100}%` }} />
            </div>
            <p>{progress?.message ?? `${settings.width}x${settings.height} / ${settings.aspectLabel}`}</p>
            <p className="backend-status">
              <Server aria-hidden="true" size={14} />
              {backendMessage}
            </p>
          </div>

          {error && <p className="error-text">{error}</p>}

          <div className="merge-actions">
            {status === "merging" ? (
              <button className="danger-button" type="button" onClick={handleCancel}>
                <X aria-hidden="true" size={18} />
                Cancel
              </button>
            ) : (
              <button className="primary-button" type="button" disabled={!canGenerate} onClick={() => void handleGenerate()}>
                {status === "probing" ? <Loader2 className="spin" aria-hidden="true" size={18} /> : <Scissors aria-hidden="true" size={18} />}
                Generate
              </button>
            )}

            <a className={`download-button ${downloadUrl ? "" : "is-disabled"}`} href={downloadUrl ?? undefined} download="merged-video.mp4">
              <Download aria-hidden="true" size={18} />
              Download
            </a>
          </div>
        </aside>
      </section>
    </main>
  );
}

function OutputControls({
  settings,
  processingMode,
  backendAvailable,
  disabled,
  onProcessingModeChange,
  onChange
}: {
  settings: OutputSettings;
  processingMode: ProcessingMode;
  backendAvailable: boolean;
  disabled: boolean;
  onProcessingModeChange: (mode: ProcessingMode) => void;
  onChange: (settings: OutputSettings) => void;
}) {
  const setPreset = (preset: (typeof aspectPresets)[number]) => {
    onChange({
      ...settings,
      width: preset.width,
      height: preset.height,
      aspectLabel: preset.label
    });
  };

  return (
    <div className="output-controls">
      <div className="segmented-control" aria-label="Output aspect ratio">
        {aspectPresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={settings.aspectLabel === preset.label ? "is-active" : ""}
            disabled={disabled}
            onClick={() => setPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label>
        <span>Width</span>
        <input
          type="number"
          min={320}
          max={3840}
          step={2}
          value={settings.width}
          disabled={disabled}
          onChange={(event) => onChange({ ...settings, width: Number(event.target.value), aspectLabel: "Custom" })}
        />
      </label>

      <label>
        <span>Height</span>
        <input
          type="number"
          min={240}
          max={3840}
          step={2}
          value={settings.height}
          disabled={disabled}
          onChange={(event) => onChange({ ...settings, height: Number(event.target.value), aspectLabel: "Custom" })}
        />
      </label>

      <label>
        <span>Fit</span>
        <select
          value={settings.aspectHandling}
          disabled={disabled}
          onChange={(event) => onChange({ ...settings, aspectHandling: event.target.value as AspectHandling })}
        >
          {Object.entries(aspectHandlingLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="mode-control">
        <span>Engine</span>
        <div className="segmented-control" aria-label="Processing engine">
          <button
            type="button"
            className={processingMode === "auto" ? "is-active" : ""}
            disabled={disabled}
            onClick={() => onProcessingModeChange("auto")}
          >
            Hybrid
          </button>
          <button
            type="button"
            className={processingMode === "backend" ? "is-active" : ""}
            disabled={disabled || !backendAvailable}
            onClick={() => onProcessingModeChange("backend")}
          >
            Backend
          </button>
          <button
            type="button"
            className={processingMode === "browser" ? "is-active" : ""}
            disabled={disabled}
            onClick={() => onProcessingModeChange("browser")}
          >
            Browser
          </button>
        </div>
      </div>
    </div>
  );
}

function chooseMergeEngine({
  browserEngine,
  backendEngine,
  backendAvailable,
  items,
  processingMode
}: {
  browserEngine: BrowserFfmpegEngine;
  backendEngine: BackendFfmpegEngine;
  backendAvailable: boolean;
  items: VideoItem[];
  processingMode: ProcessingMode;
}) {
  const totalBytes = items.reduce((total, item) => total + item.size, 0);
  const shouldUseBackend = backendAvailable && (processingMode === "backend" || (processingMode === "auto" && (items.length >= 4 || totalBytes >= 150 * 1024 * 1024)));

  if (processingMode === "backend" && !backendAvailable) {
    throw new Error("Backend FFmpeg is not available. Install ffmpeg/ffprobe or choose Browser mode.");
  }

  return shouldUseBackend ? backendEngine : browserEngine;
}

function SortableClipCard({ item, index, onRemove }: { item: VideoItem; index: number; onRemove: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  const playPreview = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = Math.min(video.currentTime, 0.2);
    void video.play();
  };

  const pausePreview = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.pause();
    video.currentTime = 0;
  };

  return (
    <li ref={setNodeRef} style={style} className={`clip-card ${isDragging ? "is-dragging" : ""}`}>
      <button className="drag-handle" type="button" title="Move clip" aria-label={`Move ${item.name}`} {...attributes} {...listeners}>
        <GripVertical aria-hidden="true" size={20} />
      </button>

      <div className="clip-index">{String(index + 1).padStart(2, "0")}</div>

      <div className="preview-frame" onMouseEnter={playPreview} onMouseLeave={pausePreview}>
        <video ref={videoRef} src={item.objectUrl} poster={item.previewUrl} muted playsInline preload="metadata" />
        {item.status === "probing" && (
          <div className="preview-busy">
            <Loader2 className="spin" aria-hidden="true" size={20} />
          </div>
        )}
      </div>

      <div className="clip-main">
        <div className="clip-title-row">
          <FileVideo aria-hidden="true" size={17} />
          <strong>{item.name}</strong>
        </div>
        <div className="clip-meta">
          <span>{formatDate(item.createdAt)}</span>
          <span>{formatBytes(item.size)}</span>
          <span>{formatDuration(item.metadata?.duration)}</span>
        </div>
        {item.error && <p className="clip-error">{item.error}</p>}
      </div>

      <div className="clip-badges">
        <span>{item.metadata ? `${item.metadata.width}x${item.metadata.height}` : "probing"}</span>
        <span>{item.metadata ? `${item.metadata.aspectRatio.toFixed(2)}:1` : "..."}</span>
        <span>{item.metadata?.hasAudio ? "audio" : "silent ok"}</span>
      </div>

      <button className="icon-button" type="button" onClick={() => onRemove(item.id)} title="Remove clip" aria-label={`Remove ${item.name}`}>
        <Trash2 aria-hidden="true" size={18} />
      </button>
    </li>
  );
}

function statusLabel(status: AppStatus, hasBlockingItem: boolean): string {
  if (hasBlockingItem) {
    return "Inspecting";
  }

  const labels: Record<AppStatus, string> = {
    idle: "Idle",
    probing: "Inspecting",
    ready: "Ready",
    merging: "Merging",
    complete: "Complete",
    error: "Needs attention"
  };

  return labels[status];
}

function revokeItemUrls(item: VideoItem) {
  URL.revokeObjectURL(item.objectUrl);
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "");
    return message.length > 0 ? message : fallback;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return fallback;
}
