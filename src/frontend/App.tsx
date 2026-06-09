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
  FolderOpen,
  GripVertical,
  Loader2,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Server,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackendFfmpegEngine, getBackendHealth } from "../processing/BackendFfmpegEngine";
import { BrowserFfmpegEngine } from "../processing/BrowserFfmpegEngine";
import { ClipPreviewModal } from "./ClipPreviewModal";
import { MissingClipsDialog } from "./MissingClipsDialog";
import {
  createVideoItem,
  cycleClipRotation,
  defaultOutputSettings,
  deriveStableClipId,
  formatBytes,
  formatDate,
  formatDuration,
  getDirectoryFromPath,
  isTransposed,
  joinPath,
  readFilePath,
  rotationDegrees,
  sortByCreationDate,
  validateVideoFiles
} from "../shared/mediaUtils";
import {
  SessionValidationError,
  parseSession,
  sessionFileBlob,
  serializeSession,
  type PickedFile
} from "../shared/sessionFile";
import { effectiveDuration, isPristine, normalizeSegments } from "../shared/trimSegments";
import type {
  AspectHandling,
  MergeProgress,
  OutputSettings,
  ProcessingMode,
  SessionClip,
  TrimSegment,
  VideoItem
} from "../shared/types";

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
  const sessionInputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<VideoItem[]>([]);
  const downloadUrlRef = useRef<string | null>(null);
  const missingClipsRef = useRef<SessionClip[]>([]);
  const sessionDirectoryRef = useRef<string | null>(null);
  const [items, setItems] = useState<VideoItem[]>([]);
  const [settings, setSettings] = useState<OutputSettings>(defaultOutputSettings);
  const [status, setStatus] = useState<AppStatus>("idle");
  const [progress, setProgress] = useState<MergeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("auto");
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [backendMessage, setBackendMessage] = useState("Checking backend");
  const [previewingItem, setPreviewingItem] = useState<VideoItem | null>(null);
  const [missingClips, setMissingClips] = useState<SessionClip[]>([]);
  const [sessionDirectory, setSessionDirectory] = useState<string | null>(null);

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
    missingClipsRef.current = missingClips;
  }, [missingClips]);

  useEffect(() => {
    sessionDirectoryRef.current = sessionDirectory;
  }, [sessionDirectory]);

  useEffect(() => {
    if (missingClips.length === 0 || items.length === 0) {
      return;
    }

    const lookup = new Map(
      missingClips.map((clip) => [deriveStableClipId(clip.name, clip.createdAt, clip.size), clip])
    );

    const matchedClipIds = new Set<string>();
    const patchedItems = items.map((item) => {
      const stableId = deriveStableClipId(item.name, item.createdAt, item.size);
      const sessionClip = lookup.get(stableId);
      if (!sessionClip) {
        return item;
      }
      matchedClipIds.add(sessionClip.id);
      if (item.rotation === sessionClip.rotation && sameSegments(item.trimSegments, sessionClip.trimSegments)) {
        return item;
      }
      return { ...item, rotation: sessionClip.rotation, trimSegments: sessionClip.trimSegments };
    });

    if (matchedClipIds.size > 0) {
      if (patchedItems !== items) {
        setItems(patchedItems);
      }
      setMissingClips((current) => current.filter((clip) => !matchedClipIds.has(clip.id)));
    }
  }, [items, missingClips]);

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
    async (picked: PickedFile[]) => {
      const files = picked.map((entry) => entry.file);
      const messages = validateVideoFiles(files);
      const validNames = new Set(
        files.filter((file) => messages.every((message) => !message.startsWith(file.name))).map((file) => file.name)
      );
      const validPicked = picked.filter((entry) => validNames.has(entry.file.name));

      setError(messages.length > 0 ? messages.join(" ") : null);

      if (validPicked.length === 0) {
        return;
      }

      resetDownload();
      setStatus("probing");

      const queuedItems = sortByCreationDate(
        validPicked.map((entry) => createVideoItem(entry.file, entry.path))
      );
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

  const ingestFromLegacyList = useCallback(
    (fileList: FileList | File[]) => {
      const picked: PickedFile[] = Array.from(fileList).map((file) => {
        const path = readFilePath(file);
        return path ? { file, path } : { file };
      });
      return ingestFiles(picked);
    },
    [ingestFiles]
  );

  const handleAddFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      void ingestFromLegacyList(event.target.files);
      event.target.value = "";
    }
  };

  const handleSaveSession = useCallback(() => {
    if (items.length === 0) {
      return;
    }
    const session = serializeSession(items, settings, processingMode);
    const blob = sessionFileBlob(session);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "video-merger-session.json";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [items, settings, processingMode]);

  const handleLoadSession = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }

      const proceed = () => {
        const reader = new FileReader();
        reader.onerror = () => {
          setError("Could not read the session file.");
        };
        reader.onload = () => {
          void (async () => {
            try {
              const raw = typeof reader.result === "string" ? reader.result : "";
              const session = parseSession(raw);

              const jsonDirectory = getDirectoryFromPath(readFilePath(file) ?? "");

              setSettings(session.settings);
              setProcessingMode(session.processingMode);
              setError(null);
              resetDownload();

              const clipsWithResolvedPaths = session.clips.map((clip) => {
                const storedDirectory = getDirectoryFromPath(clip.path);
                if (storedDirectory) {
                  return clip;
                }
                if (!jsonDirectory) {
                  return clip;
                }
                return { ...clip, path: joinPath(jsonDirectory, clip.name) };
              });

              setSessionDirectory(jsonDirectory ?? null);
              setMissingClips(clipsWithResolvedPaths);
            } catch (parseError) {
              const message =
                parseError instanceof SessionValidationError
                  ? `Invalid session file: ${parseError.message}`
                  : parseError instanceof Error
                    ? parseError.message
                    : "Could not parse the session file.";
              setError(message);
            }
          })();
        };
        reader.readAsText(file);
      };

      if (itemsRef.current.length > 0) {
        const confirmed = window.confirm("Replace current clips with this session? Unsaved changes will be lost.");
        if (!confirmed) {
          return;
        }
        handleClear();
        setMissingClips([]);
        setSessionDirectory(null);
      }
      proceed();
    },
    [resetDownload]
  );

  const resolvePickedFilePath = useCallback(
    (file: File): string | undefined => {
      const fromHandle = readFilePath(file);
      if (fromHandle) {
        return fromHandle;
      }
      const directory = sessionDirectoryRef.current;
      if (directory) {
        return joinPath(directory, file.name);
      }
      return undefined;
    },
    []
  );

  const handleRelocateMissing = useCallback(
    async (clip: SessionClip, file: File) => {
      if (file.name !== clip.name) {
        setError(
          `Selected file "${file.name}" does not match "${clip.name}". Expected at ${clip.path}.`
        );
        return;
      }

      const resolvedPath = resolvePickedFilePath(file) ?? clip.path;
      await ingestFiles([{ file, path: resolvedPath }]);
      setMissingClips((current) => current.filter((entry) => entry.id !== clip.id));
    },
    [ingestFiles, resolvePickedFilePath]
  );

  const handleRelocateBulk = useCallback(
    async (files: File[]) => {
      const stillMissing = missingClipsRef.current;
      if (stillMissing.length === 0) {
        return;
      }

      const consumedClips = new Set<string>();
      const accepted: PickedFile[] = [];
      const unmatched: string[] = [];

      const claimClip = (file: File): SessionClip | undefined => {
        const exact = stillMissing.find(
          (entry) => !consumedClips.has(entry.id) && entry.name === file.name && entry.size === file.size
        );
        if (exact) {
          consumedClips.add(exact.id);
          return exact;
        }
        const byName = stillMissing.find((entry) => !consumedClips.has(entry.id) && entry.name === file.name);
        if (byName) {
          consumedClips.add(byName.id);
          return byName;
        }
        return undefined;
      };

      for (const file of files) {
        const clip = claimClip(file);
        if (!clip) {
          unmatched.push(file.name);
          continue;
        }
        const resolvedPath = resolvePickedFilePath(file) ?? clip.path;
        accepted.push({ file, path: resolvedPath });
      }

      if (accepted.length > 0) {
        await ingestFiles(accepted);
        setMissingClips((current) => current.filter((clip) => !consumedClips.has(clip.id)));
      }

      if (unmatched.length > 0) {
        setError(
          `These files did not match any missing clip: ${unmatched.join(", ")}. Make sure the names match the session.`
        );
      } else {
        setError(null);
      }
    },
    [ingestFiles, resolvePickedFilePath]
  );

  const handleDismissMissing = useCallback(() => {
    setMissingClips([]);
  }, []);

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void ingestFromLegacyList(event.dataTransfer.files);
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

  const handleRotate = (id: string) => {
    resetDownload();
    setItems((currentItems) =>
      currentItems.map((currentItem) =>
        currentItem.id === id
          ? { ...currentItem, rotation: cycleClipRotation(currentItem.rotation) }
          : currentItem
      )
    );
  };

  const handleCommitTrim = (item: VideoItem, segments: TrimSegment[]) => {
    const duration = item.metadata?.duration ?? 0;
    const normalized = normalizeSegments(segments, duration);
    const pristine = isPristine(normalized, duration);
    resetDownload();
    setItems((currentItems) =>
      currentItems.map((currentItem) =>
        currentItem.id === item.id
          ? { ...currentItem, trimSegments: pristine ? undefined : normalized }
          : currentItem
      )
    );
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
    <>
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
          onSaveSession={handleSaveSession}
          onLoadSession={() => sessionInputRef.current?.click()}
          onProcessingModeChange={setProcessingMode}
          onChange={setSettings}
          disabled={status === "merging"}
          canSave={items.length > 0}
        />
      </header>

      <section className="workspace">
        <section className="timeline-panel" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
          {items.length === 0 ? (
            <button className="dropzone" type="button" onClick={() => void handleAddFiles()}>
              <UploadCloud aria-hidden="true" size={34} />
              <span>Drop MP4 files</span>
              <small>or pick from disk</small>
            </button>
          ) : (
            <>
              <div className="timeline-toolbar">
                <button className="secondary-button" type="button" onClick={() => void handleAddFiles()}>
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
                      <SortableClipCard key={item.id} item={item} index={index} onRemove={handleRemove} onPreview={setPreviewingItem} onRotate={handleRotate} />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </>
          )}

          <input ref={fileInputRef} type="file" accept="video/mp4,.mp4" multiple hidden onChange={handleFileChange} />
          <input
            ref={sessionInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={handleLoadSession}
          />
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

    <ClipPreviewModal
      item={previewingItem}
      onClose={() => setPreviewingItem(null)}
      onCommitSegments={handleCommitTrim}
    />

    <MissingClipsDialog
      missingClips={missingClips}
      onCancel={handleDismissMissing}
      onLocate={handleRelocateMissing}
      onLocateBulk={handleRelocateBulk}
    />
    </>
  );
}

function OutputControls({
  settings,
  processingMode,
  backendAvailable,
  disabled,
  canSave,
  onSaveSession,
  onLoadSession,
  onProcessingModeChange,
  onChange
}: {
  settings: OutputSettings;
  processingMode: ProcessingMode;
  backendAvailable: boolean;
  disabled: boolean;
  canSave: boolean;
  onSaveSession: () => void;
  onLoadSession: () => void;
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
      <div className="session-controls">
        <button
          type="button"
          className="secondary-button session-button"
          onClick={onSaveSession}
          disabled={disabled || !canSave}
          title="Save current clips, settings and engine mode to a JSON file"
        >
          <Save aria-hidden="true" size={17} />
          Save session
        </button>
        <button
          type="button"
          className="secondary-button session-button"
          onClick={onLoadSession}
          disabled={disabled}
          title="Restore a session from a JSON file"
        >
          <FolderOpen aria-hidden="true" size={17} />
          Load session
        </button>
      </div>
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

function SortableClipCard({
  item,
  index,
  onRemove,
  onPreview,
  onRotate
}: {
  item: VideoItem;
  index: number;
  onRemove: (id: string) => void;
  onPreview: (item: VideoItem) => void;
  onRotate: (id: string) => void;
}) {
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

  const handlePreviewActivate = (event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
    if ("key" in event && event.key !== "Enter" && event.key !== " ") {
      return;
    }
    if ("preventDefault" in event) {
      event.preventDefault();
    }
    pausePreview();
    onPreview(item);
  };

  const canPreview = item.status === "ready";
  const rotationDeg = rotationDegrees(item.rotation);
  const previewAspect = computePreviewAspect(item);

  return (
    <li ref={setNodeRef} style={style} className={`clip-card ${isDragging ? "is-dragging" : ""}`}>
      <button className="drag-handle" type="button" title="Move clip" aria-label={`Move ${item.name}`} {...attributes} {...listeners}>
        <GripVertical aria-hidden="true" size={20} />
      </button>

      <div className="clip-index">{String(index + 1).padStart(2, "0")}</div>

      <div
        className="preview-frame"
        onMouseEnter={canPreview ? playPreview : undefined}
        onMouseLeave={canPreview ? pausePreview : undefined}
        onClick={canPreview ? handlePreviewActivate : undefined}
        onKeyDown={canPreview ? handlePreviewActivate : undefined}
        role={canPreview ? "button" : undefined}
        tabIndex={canPreview ? 0 : -1}
        aria-label={canPreview ? `Open preview of ${item.name}` : undefined}
        aria-disabled={!canPreview}
        style={{ ["--preview-aspect" as string]: previewAspect }}
      >
        <video
          ref={videoRef}
          src={item.objectUrl}
          poster={item.previewUrl}
          muted
          playsInline
          preload="metadata"
          className={item.rotation ? "is-rotated" : undefined}
          style={item.rotation ? { transform: `rotate(${rotationDeg}deg)` } : undefined}
        />
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
          <span>
            {item.trimSegments && item.trimSegments.length > 0
              ? `${formatDuration(effectiveDuration(item))} / ${formatDuration(item.metadata?.duration)}`
              : formatDuration(item.metadata?.duration)}
          </span>
        </div>
        {item.error && <p className="clip-error">{item.error}</p>}
      </div>

      <div className="clip-badges">
        <span>{item.metadata ? `${item.metadata.width}x${item.metadata.height}` : "probing"}</span>
        <span>{item.metadata ? `${item.metadata.aspectRatio.toFixed(2)}:1` : "..."}</span>
        <span>{item.metadata?.hasAudio ? "audio" : "silent ok"}</span>
        {item.rotation !== 0 && <span className="clip-badge-rotation">{rotationDeg}°</span>}
        {item.trimSegments && item.trimSegments.length > 0 && (
          <span className="clip-badge-trim" title="Trimmed">
            trimmed
          </span>
        )}
      </div>

      <button
        className="icon-button"
        type="button"
        onClick={() => onRotate(item.id)}
        title="Rotate 90°"
        aria-label={`Rotate ${item.name} 90°`}
        aria-pressed={item.rotation !== 0}
      >
        <RotateCw aria-hidden="true" size={18} />
      </button>

      <button className="icon-button" type="button" onClick={() => onRemove(item.id)} title="Remove clip" aria-label={`Remove ${item.name}`}>
        <Trash2 aria-hidden="true" size={18} />
      </button>
    </li>
  );
}

function computePreviewAspect(item: VideoItem): string {
  const metadata = item.metadata;
  if (!metadata || metadata.width <= 0 || metadata.height <= 0) {
    return "16 / 9";
  }

  const ratio = isTransposed(item.rotation) ? metadata.height / metadata.width : metadata.width / metadata.height;
  return `${ratio} / 1`;
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

function sameSegments(a: TrimSegment[] | undefined, b: TrimSegment[] | undefined): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left || !right) {
      return false;
    }
    if (left.start !== right.start || left.end !== right.end) {
      return false;
    }
  }
  return true;
}
