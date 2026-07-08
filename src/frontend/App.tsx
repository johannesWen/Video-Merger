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
  Copy,
  Download,
  Eye,
  FileVideo,
  Film,
  FolderOpen,
  GripVertical,
  Image as ImageIcon,
  Keyboard,
  Loader2,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  Moon,
  Music,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Scissors,
  Server,
  StickyNote,
  Sun,
  Trash2,
  Undo2,
  UploadCloud,
  X
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackendFfmpegEngine, getBackendHealth } from "../processing/BackendFfmpegEngine";
import { BrowserFfmpegEngine } from "../processing/BrowserFfmpegEngine";
import { getVideoBitrate } from "../processing/ffmpegSegments";
import { buildContactSheet, captureFrameUrl, computeWaveformPeaks, triggerDownload } from "./canvasUtils";
import { ClipPreviewModal, type ClipEditResult } from "./ClipPreviewModal";
import { CompositionPreviewModal } from "./CompositionPreviewModal";
import { MissingClipsDialog } from "./MissingClipsDialog";
import { ShortcutsModal } from "./ShortcutsModal";
import {
  buildClipsCsv,
  buildProjectSummary,
  clampCrossfade,
  clampSpeed,
  clipOutputDuration,
  cloneVideoItem,
  createVideoItem,
  cycleClipRotation,
  defaultOutputSettings,
  deriveStableClipId,
  estimateOutputBytes,
  findDuplicateNames,
  formatBytes,
  formatDate,
  formatDuration,
  getDirectoryFromPath,
  isTransposed,
  joinPath,
  normalizeOutputSettings,
  readFilePath,
  rotationDegrees,
  sanitizeOutputName,
  sortByCreationDate,
  totalCompositionDuration,
  validateVideoFiles
} from "../shared/mediaUtils";
import {
  SessionValidationError,
  parseSession,
  sessionFileBlob,
  serializeSession,
  type PickedFile
} from "../shared/sessionFile";
import { effectiveDuration, isPristine, normalizeSegments, splitAt } from "../shared/trimSegments";
import { createZip } from "../shared/zipUtils";
import { defaultColorAdjust } from "../shared/types";
import type {
  AspectHandling,
  BackgroundMusicSettings,
  ColorAdjust,
  MergeExtras,
  MergeProgress,
  OutputSettings,
  ProcessingMode,
  SessionClip,
  SessionFile,
  TextOverlay,
  Theme,
  TrimSegment,
  VideoItem,
  WatermarkPosition,
  WatermarkSettings
} from "../shared/types";

type AppStatus = "idle" | "probing" | "ready" | "merging" | "complete" | "error";

const THEME_STORAGE_KEY = "video-merger-theme";
const AUTOSAVE_STORAGE_KEY = "video-merger-autosave";
const AUTOSAVE_HISTORY_KEY = "video-merger-autosave-history";
const OUTPUT_DEFAULTS_KEY = "video-merger-output-defaults";
const CONFIRM_DESTRUCTIVE_KEY = "video-merger-confirm-destructive";
const HISTORY_LIMIT = 20;
const BIN_LIMIT = 12;
const AUTOSAVE_HISTORY_LIMIT = 5;
const TAG_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

const aspectPresets = [
  { label: "16:9 720p", width: 1280, height: 720 },
  { label: "16:9 1080p", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "Instagram Reel", width: 1080, height: 1920 },
  { label: "TikTok", width: 1080, height: 1920 },
  { label: "YouTube Shorts", width: 1080, height: 1920 },
  { label: "Instagram Story", width: 1080, height: 1920 },
  { label: "Square Post", width: 1080, height: 1080 }
];

interface Toast {
  id: number;
  kind: "success" | "info" | "warning";
  text: string;
}

interface EffectsClipboard {
  volume: number;
  muted: boolean;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  colorAdjust: ColorAdjust;
  reversed: boolean;
  freezeFrame: number;
  textOverlay?: TextOverlay;
}

interface ContextMenuState {
  x: number;
  y: number;
  itemId: string;
}

interface AutosaveSnapshot {
  savedAt: number;
  session: SessionFile;
}

function loadStoredTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "high-contrast") {
    return stored;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadStoredOutputSettings(): OutputSettings {
  try {
    const raw = window.localStorage.getItem(OUTPUT_DEFAULTS_KEY);
    if (!raw) {
      return defaultOutputSettings;
    }
    return normalizeOutputSettings(JSON.parse(raw) as Partial<OutputSettings>);
  } catch {
    return defaultOutputSettings;
  }
}

function loadAutosaveHistory(): AutosaveSnapshot[] {
  try {
    const raw = window.localStorage.getItem(AUTOSAVE_HISTORY_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => entry as AutosaveSnapshot)
      .filter((entry) => entry && typeof entry.savedAt === "number" && entry.session);
  } catch {
    return [];
  }
}

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
  const [settings, setSettings] = useState<OutputSettings>(loadStoredOutputSettings);
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
  const [theme, setTheme] = useState<Theme>(loadStoredTheme);
  const [past, setPast] = useState<VideoItem[][]>([]);
  const [future, setFuture] = useState<VideoItem[][]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showExtras, setShowExtras] = useState(false);
  const [watermark, setWatermark] = useState<WatermarkSettings | null>(null);
  const [backgroundMusic, setBackgroundMusic] = useState<BackgroundMusicSettings | null>(null);
  const [gifBusy, setGifBusy] = useState(false);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [autosavePrompt, setAutosavePrompt] = useState<SessionFile | null>(null);
  const [autosaveHistory, setAutosaveHistory] = useState<AutosaveSnapshot[]>([]);
  const [eta, setEta] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set<string>());
  const [filterText, setFilterText] = useState("");
  const [compactView, setCompactView] = useState(false);
  const [timelineFullscreen, setTimelineFullscreen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [deletedBin, setDeletedBin] = useState<VideoItem[]>([]);
  const [showBin, setShowBin] = useState(false);
  const [effectsClipboard, setEffectsClipboard] = useState<EffectsClipboard | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showCompositionPreview, setShowCompositionPreview] = useState(false);
  const [contactSheetBusy, setContactSheetBusy] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState<boolean>(() => {
    return window.localStorage.getItem(CONFIRM_DESTRUCTIVE_KEY) === "1";
  });
  const errorLogRef = useRef<string[]>([]);
  const mergeStartRef = useRef<number | null>(null);
  const watermarkInputRef = useRef<HTMLInputElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const toastIdRef = useRef(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const readyCount = items.filter((item) => item.status === "ready").length;
  const hasBlockingItem = items.some((item) => item.status === "probing" || item.status === "error");
  const canGenerate = items.length > 0 && readyCount === items.length && status !== "merging";
  const readyItems = useMemo(() => items.filter((item) => item.status === "ready" && item.metadata), [items]);
  const totalDuration = useMemo(() => totalCompositionDuration(readyItems), [readyItems]);
  const estimatedBytes = useMemo(
    () => estimateOutputBytes(totalDuration, parseInt(getVideoBitrate(settings), 10)),
    [settings, totalDuration]
  );
  const visibleItems = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (query.length === 0) {
      return items;
    }
    return items.filter(
      (item) => item.name.toLowerCase().includes(query) || (item.tagText ?? "").toLowerCase().includes(query)
    );
  }, [filterText, items]);
  const isFiltering = filterText.trim().length > 0;

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((current) => [...current.slice(-4), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

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
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Remember last-used output settings across sessions (independent from full session autosave).
  useEffect(() => {
    window.localStorage.setItem(OUTPUT_DEFAULTS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(CONFIRM_DESTRUCTIVE_KEY, confirmDestructive ? "1" : "0");
  }, [confirmDestructive]);

  // Warn before leaving the tab while clips are loaded.
  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [items.length > 0]);

  useEffect(() => {
    if (itemsRef.current.length > 0) {
      return;
    }
    const raw = window.localStorage.getItem(AUTOSAVE_STORAGE_KEY);
    setAutosaveHistory(loadAutosaveHistory());
    if (!raw) {
      return;
    }
    try {
      setAutosavePrompt(parseSession(raw));
    } catch {
      window.localStorage.removeItem(AUTOSAVE_STORAGE_KEY);
    }
    // Only ever check once, right after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      window.localStorage.removeItem(AUTOSAVE_STORAGE_KEY);
      return;
    }
    const timeout = window.setTimeout(() => {
      const session = serializeSession(items, settings, processingMode);
      window.localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(session));

      // Keep a small history of timestamped autosave snapshots (min ~2 minutes apart).
      try {
        const history = loadAutosaveHistory();
        const last = history[history.length - 1];
        if (!last || session.savedAt - last.savedAt > 120_000) {
          const next = [...history, { savedAt: session.savedAt, session }].slice(-AUTOSAVE_HISTORY_LIMIT);
          window.localStorage.setItem(AUTOSAVE_HISTORY_KEY, JSON.stringify(next));
        }
      } catch {
        // History is best-effort; the latest autosave is the important one.
      }
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [items, settings, processingMode]);

  useEffect(() => {
    if (status !== "merging" || !progress || progress.ratio <= 0.02) {
      setEta(null);
      return;
    }
    if (mergeStartRef.current === null) {
      mergeStartRef.current = Date.now();
    }
    const elapsedSeconds = (Date.now() - mergeStartRef.current) / 1000;
    const remainingSeconds = Math.max(0, (elapsedSeconds / progress.ratio) * (1 - progress.ratio));
    setEta(formatDuration(remainingSeconds));
  }, [progress, status]);

  useEffect(() => {
    if (status !== "merging") {
      mergeStartRef.current = null;
    }
  }, [status]);

  useEffect(() => {
    return () => {
      if (gifUrl) {
        URL.revokeObjectURL(gifUrl);
      }
    };
  }, [gifUrl]);

  useEffect(() => {
    if (error) {
      errorLogRef.current = [...errorLogRef.current, `[${new Date().toISOString()}] ${error}`];
    }
  }, [error]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't hijack typing inside form fields (rename input, filter box, settings...).
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select") || target.isContentEditable)) {
        return;
      }
      if (event.key === "?") {
        setShowShortcuts((current) => !current);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && itemsRef.current.length > 0) {
        event.preventDefault();
        setSelectedIds(new Set(itemsRef.current.map((item) => item.id)));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, future]);

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

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const resetDownload = useCallback(() => {
    setDownloadUrl((currentUrl) => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
      return null;
    });
    // A stale GIF from a previous merge must not be offered next to a new/edited composition.
    setGifUrl((currentGif) => {
      if (currentGif) {
        URL.revokeObjectURL(currentGif);
      }
      return null;
    });
  }, []);

  const snapshotHistory = useCallback(() => {
    setPast((current) => [...current.slice(-(HISTORY_LIMIT - 1)), itemsRef.current]);
    setFuture([]);
  }, []);

  const handleUndo = useCallback(() => {
    setPast((currentPast) => {
      if (currentPast.length === 0) {
        return currentPast;
      }
      const previous = currentPast[currentPast.length - 1];
      setFuture((currentFuture) => [itemsRef.current, ...currentFuture]);
      setItems(previous);
      return currentPast.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setFuture((currentFuture) => {
      if (currentFuture.length === 0) {
        return currentFuture;
      }
      const [next, ...rest] = currentFuture;
      setPast((currentPast) => [...currentPast, itemsRef.current]);
      setItems(next);
      return rest;
    });
  }, []);

  const confirmDanger = useCallback(
    (message: string): boolean => {
      if (!confirmDestructive) {
        return true;
      }
      return window.confirm(message);
    },
    [confirmDestructive]
  );

  const ingestFiles = useCallback(
    async (picked: PickedFile[], insertIndex?: number) => {
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

      const duplicates = findDuplicateNames(itemsRef.current, validPicked.map((entry) => entry.file));
      if (duplicates.length > 0) {
        pushToast("warning", `Possible duplicate clip${duplicates.length > 1 ? "s" : ""}: ${duplicates.join(", ")}`);
      }

      snapshotHistory();
      resetDownload();
      setStatus("probing");

      const queuedItems = sortByCreationDate(
        validPicked.map((entry) => createVideoItem(entry.file, entry.path))
      );
      setItems((currentItems) => {
        if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= currentItems.length) {
          return [...currentItems.slice(0, insertIndex), ...queuedItems, ...currentItems.slice(insertIndex)];
        }
        return [...currentItems, ...queuedItems];
      });

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

            if (metadata.hasAudio) {
              // Waveform peaks are decoded lazily in the background; failures are silent.
              void computeWaveformPeaks(item.file).then((peaks) => {
                if (peaks.length > 0) {
                  setItems((currentItems) =>
                    currentItems.map((currentItem) =>
                      currentItem.id === item.id ? { ...currentItem, waveform: peaks } : currentItem
                    )
                  );
                }
              });
            }
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
    [browserEngine, pushToast, resetDownload, snapshotHistory]
  );

  const ingestFromLegacyList = useCallback(
    (fileList: FileList | File[], insertIndex?: number) => {
      const picked: PickedFile[] = Array.from(fileList).map((file) => {
        const path = readFilePath(file);
        return path ? { file, path } : { file };
      });
      return ingestFiles(picked, insertIndex);
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
    triggerDownload(sessionFileBlob(session), "video-merger-session.json");
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

              setSettings(normalizeOutputSettings(session.settings));
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
        handleClear(true);
        setMissingClips([]);
        setSessionDirectory(null);
      }
      proceed();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const index = dropIndex;
    setDropIndex(null);
    void ingestFromLegacyList(event.dataTransfer.files, index ?? undefined);
  };

  const moveToBin = useCallback((removed: VideoItem[]) => {
    if (removed.length === 0) {
      return;
    }
    // Object URLs stay alive so undo / restore-from-bin keeps a working preview.
    setDeletedBin((current) => [...removed, ...current].slice(0, BIN_LIMIT));
  }, []);

  const handleRemove = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (!item || item.locked) {
      if (item?.locked) {
        pushToast("warning", `"${item.name}" is locked.`);
      }
      return;
    }
    if (!confirmDanger(`Remove "${item.name}" from the timeline?`)) {
      return;
    }
    snapshotHistory();
    resetDownload();
    moveToBin([item]);
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setItems((currentItems) => currentItems.filter((entry) => entry.id !== id));
  };

  const handleRotate = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (item?.locked) {
      pushToast("warning", `"${item.name}" is locked.`);
      return;
    }
    snapshotHistory();
    resetDownload();
    setItems((currentItems) =>
      currentItems.map((currentItem) =>
        currentItem.id === id
          ? { ...currentItem, rotation: cycleClipRotation(currentItem.rotation) }
          : currentItem
      )
    );
  };

  const handleDuplicate = (id: string) => {
    snapshotHistory();
    resetDownload();
    setItems((currentItems) => {
      const index = currentItems.findIndex((item) => item.id === id);
      if (index === -1) {
        return currentItems;
      }
      const duplicate = cloneVideoItem(currentItems[index]);
      return [...currentItems.slice(0, index + 1), duplicate, ...currentItems.slice(index + 1)];
    });
  };

  const handleStartRename = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (item?.locked) {
      pushToast("warning", `"${item.name}" is locked.`);
      return;
    }
    setRenamingId(id);
  };

  const handleRenameCommit = (id: string, name: string) => {
    snapshotHistory();
    const trimmed = name.trim();
    setRenamingId(null);
    if (trimmed.length === 0) {
      return;
    }
    setItems((currentItems) =>
      currentItems.map((currentItem) => (currentItem.id === id ? { ...currentItem, name: trimmed } : currentItem))
    );
  };

  const patchItem = useCallback(
    (id: string, patch: Partial<VideoItem> | ((item: VideoItem) => Partial<VideoItem>), snapshot = true) => {
      if (snapshot) {
        snapshotHistory();
      }
      setItems((currentItems) =>
        currentItems.map((currentItem) =>
          currentItem.id === id
            ? { ...currentItem, ...(typeof patch === "function" ? patch(currentItem) : patch) }
            : currentItem
        )
      );
    },
    [snapshotHistory]
  );

  const handleApplyClipEdit = (item: VideoItem, result: ClipEditResult) => {
    if (item.locked) {
      pushToast("warning", `"${item.name}" is locked.`);
      return;
    }
    const duration = item.metadata?.duration ?? 0;
    const normalized = normalizeSegments(result.trimSegments, duration);
    const pristine = isPristine(normalized, duration);
    snapshotHistory();
    resetDownload();
    setItems((currentItems) =>
      currentItems.map((currentItem) =>
        currentItem.id === item.id
          ? {
              ...currentItem,
              trimSegments: pristine ? undefined : normalized,
              volume: result.volume,
              muted: result.muted,
              speed: result.speed,
              fadeIn: result.fadeIn,
              fadeOut: result.fadeOut,
              colorAdjust: result.colorAdjust,
              reversed: result.reversed || undefined,
              freezeFrame: result.freezeFrame > 0 ? result.freezeFrame : undefined,
              textOverlay: result.textOverlay,
              note: result.note
            }
          : currentItem
      )
    );
  };

  const handleRegeneratePoster = useCallback(
    (item: VideoItem, atTime: number) => {
      void captureFrameUrl(item.objectUrl, atTime)
        .then((url) => {
          setItems((currentItems) =>
            currentItems.map((currentItem) => {
              if (currentItem.id !== item.id) {
                return currentItem;
              }
              if (currentItem.previewUrl) {
                URL.revokeObjectURL(currentItem.previewUrl);
              }
              return { ...currentItem, previewUrl: url };
            })
          );
          pushToast("success", `Thumbnail updated for ${item.name}.`);
        })
        .catch(() => pushToast("warning", "Could not capture that frame."));
    },
    [pushToast]
  );

  const handleSplitClip = (item: VideoItem, atTime: number) => {
    const duration = item.metadata?.duration ?? 0;
    if (duration <= 0) {
      return;
    }
    const baseSegments = normalizeSegments(item.trimSegments, duration);
    const splitSegments = splitAt(baseSegments, atTime);
    if (splitSegments.length < 2) {
      return;
    }
    const splitIndex = splitSegments.findIndex((segment) => segment.end - 1e-3 <= atTime);
    const firstSegments = splitSegments.slice(0, splitIndex + 1);
    const secondSegments = splitSegments.slice(splitIndex + 1);

    snapshotHistory();
    resetDownload();
    setItems((currentItems) => {
      const index = currentItems.findIndex((current) => current.id === item.id);
      if (index === -1) {
        return currentItems;
      }
      const first: VideoItem = { ...currentItems[index], trimSegments: firstSegments };
      const second: VideoItem = { ...cloneVideoItem(currentItems[index]), trimSegments: secondSegments };
      return [...currentItems.slice(0, index), first, second, ...currentItems.slice(index + 1)];
    });
  };

  const handleClear = (skipConfirm = false) => {
    if (!skipConfirm && !confirmDanger("Clear all clips from the timeline?")) {
      return;
    }
    snapshotHistory();
    resetDownload();
    setError(null);
    setProgress(null);
    setStatus("idle");
    setSelectedIds(new Set<string>());
    setItems((currentItems) => {
      moveToBin(currentItems.filter((item) => !item.locked));
      return [];
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    snapshotHistory();
    resetDownload();
    setItems((currentItems) => {
      const oldIndex = currentItems.findIndex((item) => item.id === active.id);
      const newIndex = currentItems.findIndex((item) => item.id === over.id);

      return arrayMove(currentItems, oldIndex, newIndex);
    });
  };

  // -------- selection --------

  const handleSelectItem = useCallback((id: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const orderIds = itemsRef.current.map((item) => item.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (event.shiftKey && lastSelectedRef.current) {
        const fromIndex = orderIds.indexOf(lastSelectedRef.current);
        const toIndex = orderIds.indexOf(id);
        if (fromIndex !== -1 && toIndex !== -1) {
          const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
          for (let index = start; index <= end; index += 1) {
            next.add(orderIds[index]);
          }
          return next;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        lastSelectedRef.current = id;
        return next;
      }
      lastSelectedRef.current = id;
      return new Set([id]);
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(itemsRef.current.map((item) => item.id)));
  }, []);

  const handleSelectNone = useCallback(() => {
    setSelectedIds(new Set<string>());
    lastSelectedRef.current = null;
  }, []);

  const selectedItems = useMemo(() => items.filter((item) => selectedIds.has(item.id)), [items, selectedIds]);

  const handleBulkDelete = () => {
    const removable = selectedItems.filter((item) => !item.locked);
    if (removable.length === 0) {
      return;
    }
    if (!confirmDanger(`Remove ${removable.length} selected clip${removable.length > 1 ? "s" : ""}?`)) {
      return;
    }
    snapshotHistory();
    resetDownload();
    moveToBin(removable);
    const removedIds = new Set(removable.map((item) => item.id));
    setItems((currentItems) => currentItems.filter((item) => !removedIds.has(item.id)));
    setSelectedIds(new Set<string>());
    pushToast("info", `${removable.length} clip${removable.length > 1 ? "s" : ""} moved to the deleted bin.`);
  };

  const handleBulkRotate = () => {
    snapshotHistory();
    resetDownload();
    setItems((currentItems) =>
      currentItems.map((item) =>
        selectedIds.has(item.id) && !item.locked ? { ...item, rotation: cycleClipRotation(item.rotation) } : item
      )
    );
  };

  const handleBulkMute = (muted: boolean) => {
    snapshotHistory();
    resetDownload();
    setItems((currentItems) =>
      currentItems.map((item) => (selectedIds.has(item.id) && !item.locked ? { ...item, muted } : item))
    );
  };

  // -------- per-clip quick actions --------

  const moveItemToIndex = useCallback(
    (id: string, targetIndex: number) => {
      snapshotHistory();
      resetDownload();
      setItems((currentItems) => {
        const fromIndex = currentItems.findIndex((item) => item.id === id);
        if (fromIndex === -1) {
          return currentItems;
        }
        const bounded = Math.min(currentItems.length - 1, Math.max(0, targetIndex));
        return arrayMove(currentItems, fromIndex, bounded);
      });
    },
    [resetDownload, snapshotHistory]
  );

  const handleToggleLock = (id: string) => {
    patchItem(id, (item) => ({ locked: !item.locked }));
  };

  const handleSetTagColor = (id: string, color: string | undefined) => {
    patchItem(id, { tagColor: color });
  };

  const handleSetTagText = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    const text = window.prompt("Tag text (empty to clear):", item?.tagText ?? "");
    if (text === null) {
      return;
    }
    patchItem(id, { tagText: text.trim().length > 0 ? text.trim().slice(0, 24) : undefined });
  };

  const handleSetMarker = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    const label = window.prompt("Chapter/marker label shown before this clip (empty to clear):", item?.markerLabel ?? "");
    if (label === null) {
      return;
    }
    patchItem(id, { markerLabel: label.trim().length > 0 ? label.trim().slice(0, 60) : undefined });
  };

  const handleEditNote = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    const note = window.prompt("Clip note (empty to clear):", item?.note ?? "");
    if (note === null) {
      return;
    }
    patchItem(id, { note: note.trim().length > 0 ? note.trim().slice(0, 500) : undefined });
  };

  const handleMoveToPosition = (id: string) => {
    const total = itemsRef.current.length;
    const currentIndex = itemsRef.current.findIndex((item) => item.id === id);
    const raw = window.prompt(`Move clip to position (1-${total}):`, String(currentIndex + 1));
    if (raw === null) {
      return;
    }
    const position = Number.parseInt(raw, 10);
    if (!Number.isInteger(position) || position < 1 || position > total) {
      pushToast("warning", `Enter a position between 1 and ${total}.`);
      return;
    }
    moveItemToIndex(id, position - 1);
  };

  const handleCopyEffects = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    setEffectsClipboard({
      volume: item.volume,
      muted: item.muted,
      speed: item.speed,
      fadeIn: item.fadeIn,
      fadeOut: item.fadeOut,
      colorAdjust: { ...item.colorAdjust },
      reversed: item.reversed === true,
      freezeFrame: item.freezeFrame ?? 0,
      textOverlay: item.textOverlay ? { ...item.textOverlay } : undefined
    });
    pushToast("success", `Copied effects from ${item.name}.`);
  };

  const applyEffectsTo = useCallback(
    (predicate: (item: VideoItem) => boolean) => {
      if (!effectsClipboard) {
        return;
      }
      snapshotHistory();
      resetDownload();
      setItems((currentItems) =>
        currentItems.map((item) =>
          predicate(item) && !item.locked
            ? {
                ...item,
                volume: effectsClipboard.volume,
                muted: effectsClipboard.muted,
                speed: effectsClipboard.speed,
                fadeIn: effectsClipboard.fadeIn,
                fadeOut: effectsClipboard.fadeOut,
                colorAdjust: { ...effectsClipboard.colorAdjust },
                reversed: effectsClipboard.reversed || undefined,
                freezeFrame: effectsClipboard.freezeFrame > 0 ? effectsClipboard.freezeFrame : undefined,
                textOverlay: effectsClipboard.textOverlay ? { ...effectsClipboard.textOverlay } : undefined
              }
            : item
        )
      );
    },
    [effectsClipboard, resetDownload, snapshotHistory]
  );

  const handlePasteEffects = (id: string) => {
    applyEffectsTo((item) => item.id === id);
  };

  const handlePasteEffectsToSelected = () => {
    applyEffectsTo((item) => selectedIds.has(item.id));
    pushToast("success", `Effects applied to ${selectedIds.size} clip${selectedIds.size > 1 ? "s" : ""}.`);
  };

  const handlePasteEffectsToAll = () => {
    applyEffectsTo(() => true);
    pushToast("success", "Effects applied to all clips.");
  };

  const handleResetEffects = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id);
    if (item?.locked) {
      pushToast("warning", `"${item.name}" is locked.`);
      return;
    }
    resetDownload();
    patchItem(id, {
      volume: 1,
      muted: false,
      speed: 1,
      fadeIn: 0,
      fadeOut: 0,
      colorAdjust: { ...defaultColorAdjust },
      reversed: undefined,
      freezeFrame: undefined,
      textOverlay: undefined
    });
  };

  const handleGlobalSpeed = (speed: number) => {
    const clamped = clampSpeed(speed);
    snapshotHistory();
    resetDownload();
    setItems((currentItems) => currentItems.map((item) => (item.locked ? item : { ...item, speed: clamped })));
    pushToast("info", `Speed ${clamped}x applied to all clips.`);
  };

  const handleToggleCrossfade = (id: string) => {
    resetDownload();
    patchItem(id, (item) => ({
      crossfadeAfter: (item.crossfadeAfter ?? 0) > 0 ? undefined : 0.5
    }));
  };

  const handleCrossfadeDuration = (id: string, value: number) => {
    resetDownload();
    patchItem(id, { crossfadeAfter: clampCrossfade(value) }, false);
  };

  const handleRestoreFromBin = (id: string) => {
    const entry = deletedBin.find((item) => item.id === id);
    if (!entry) {
      return;
    }
    setDeletedBin((current) => current.filter((item) => item.id !== id));
    if (itemsRef.current.some((item) => item.id === id)) {
      return;
    }
    snapshotHistory();
    resetDownload();
    setItems((currentItems) => [...currentItems, entry]);
    pushToast("success", `Restored ${entry.name}.`);
  };

  // -------- exports & sharing --------

  const handleExportCsv = () => {
    triggerDownload(new Blob([buildClipsCsv(items)], { type: "text/csv" }), `${settings.outputName}-clips.csv`);
  };

  const handleExportZip = () => {
    const session = serializeSession(items, settings, processingMode);
    const manifest = [
      "Clips referenced by this project (media files are NOT embedded):",
      ...session.clips.map((clip) => `${clip.name}\t${clip.path}`)
    ].join("\n");
    const zip = createZip([
      { name: "session.videomerge.json", data: JSON.stringify(session, null, 2) },
      { name: "clips-manifest.txt", data: manifest }
    ]);
    triggerDownload(zip, `${settings.outputName}-project.zip`);
    pushToast("success", "Project bundle exported.");
  };

  const handleCopySummary = () => {
    const summary = buildProjectSummary(items, settings);
    void navigator.clipboard
      .writeText(summary)
      .then(() => pushToast("success", "Project summary copied to clipboard."))
      .catch(() => pushToast("warning", "Could not access the clipboard."));
  };

  const handleContactSheet = () => {
    setContactSheetBusy(true);
    void buildContactSheet(items)
      .then((blob) => {
        triggerDownload(blob, `${settings.outputName}-contact-sheet.png`);
        pushToast("success", "Contact sheet exported.");
      })
      .catch((sheetError) =>
        pushToast("warning", sheetError instanceof Error ? sheetError.message : "Could not build the contact sheet.")
      )
      .finally(() => setContactSheetBusy(false));
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

      const extras: MergeExtras = {
        ...(watermark ? { watermark } : {}),
        ...(backgroundMusic ? { backgroundMusic } : {})
      };
      const blob = await selectedEngine.merge(items, settings, setProgress, extras);
      setDownloadUrl(URL.createObjectURL(blob));
      setStatus("complete");
      pushToast("success", "Merge complete — ready to download.");
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

  const handleExportGif = async () => {
    if (!downloadUrl) {
      return;
    }
    setGifBusy(true);
    setError(null);
    try {
      const response = await fetch(downloadUrl);
      const sourceBlob = await response.blob();
      const gifBlob = await browserEngine.convertToGif(sourceBlob);
      setGifUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return URL.createObjectURL(gifBlob);
      });
      pushToast("success", "GIF ready.");
    } catch (gifError) {
      setError(getErrorMessage(gifError, "Could not create the GIF."));
    } finally {
      setGifBusy(false);
    }
  };

  const handleExportErrorLog = () => {
    if (errorLogRef.current.length === 0) {
      return;
    }
    triggerDownload(new Blob([errorLogRef.current.join("\n")], { type: "text/plain" }), "video-merger-error-log.txt");
  };

  const handleWatermarkFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setWatermark({ file, opacity: 0.8, position: "bottom-right", scale: 0.16 });
  };

  const handleMusicFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setBackgroundMusic({ file, volume: 0.5 });
  };

  const restoreAutosaveSession = (session: SessionFile) => {
    setSettings(normalizeOutputSettings(session.settings));
    setProcessingMode(session.processingMode);
    setMissingClips(session.clips);
    setAutosavePrompt(null);
  };

  const handleDismissAutosave = () => {
    setAutosavePrompt(null);
    window.localStorage.removeItem(AUTOSAVE_STORAGE_KEY);
    window.localStorage.removeItem(AUTOSAVE_HISTORY_KEY);
    setAutosaveHistory([]);
  };

  const cycleTheme = () => {
    setTheme((current) => (current === "light" ? "dark" : current === "dark" ? "high-contrast" : "light"));
  };

  const contextItem = contextMenu ? items.find((item) => item.id === contextMenu.itemId) ?? null : null;

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
            <p>
              {items.length === 0
                ? "No clips loaded"
                : `${items.length} clips / ${readyCount} ready / ${formatDuration(totalDuration)} total`}
            </p>
          </div>
          <div className="topbar-tools">
            <button
              type="button"
              className="icon-button"
              onClick={handleUndo}
              disabled={past.length === 0}
              title="Undo"
              aria-label="Undo"
            >
              <Undo2 aria-hidden="true" size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={handleRedo}
              disabled={future.length === 0}
              title="Redo"
              aria-label="Redo"
            >
              <Redo2 aria-hidden="true" size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowShortcuts(true)}
              title="Keyboard shortcuts"
              aria-label="Keyboard shortcuts"
            >
              <Keyboard aria-hidden="true" size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={cycleTheme}
              title={`Theme: ${theme} (click to cycle light / dark / high contrast)`}
              aria-label="Cycle color theme"
            >
              {theme === "dark" ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
            </button>
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

      {autosavePrompt && (
        <div className="autosave-banner">
          <span>Found an autosaved project. Restore its settings and relink clips?</span>
          <div className="autosave-banner-actions">
            {autosaveHistory.length > 1 && (
              <label className="autosave-history-picker">
                <span>Snapshot</span>
                <select
                  aria-label="Choose autosave snapshot to restore"
                  defaultValue="latest"
                  onChange={(event) => {
                    if (event.target.value === "latest") {
                      return;
                    }
                    const snapshot = autosaveHistory.find((entry) => String(entry.savedAt) === event.target.value);
                    if (snapshot) {
                      restoreAutosaveSession(snapshot.session);
                    }
                  }}
                >
                  <option value="latest">Latest</option>
                  {[...autosaveHistory].reverse().map((entry) => (
                    <option key={entry.savedAt} value={String(entry.savedAt)}>
                      {formatDate(entry.savedAt)} ({entry.session.clips.length} clips)
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className="secondary-button" onClick={handleDismissAutosave}>
              Dismiss
            </button>
            <button type="button" className="primary-button" onClick={() => restoreAutosaveSession(autosavePrompt)}>
              Restore
            </button>
          </div>
        </div>
      )}

      <section className="workspace">
        <section
          className={`timeline-panel ${timelineFullscreen ? "is-fullscreen" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          onDragLeave={(event) => {
            if (event.target === event.currentTarget) {
              setDropIndex(null);
            }
          }}
        >
          {items.length === 0 ? (
            <button className="dropzone" type="button" onClick={() => void handleAddFiles()}>
              <UploadCloud aria-hidden="true" size={34} />
              <span>Drop video files</span>
              <small>MP4, MOV, WebM, MKV</small>
            </button>
          ) : (
            <>
              <div className="timeline-toolbar">
                <button className="secondary-button" type="button" onClick={() => void handleAddFiles()}>
                  <UploadCloud aria-hidden="true" size={17} />
                  Add
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setShowExtras((current) => !current)}
                >
                  <ImageIcon aria-hidden="true" size={17} />
                  Watermark / Music
                </button>
                <input
                  type="search"
                  className="clip-filter-input"
                  placeholder="Filter clips…"
                  value={filterText}
                  onChange={(event) => setFilterText(event.target.value)}
                  aria-label="Filter clips by name or tag"
                />
                <label className="global-speed-control" title="Apply a speed multiplier to every clip">
                  <span>All speed</span>
                  <select
                    aria-label="Apply global speed to all clips"
                    value=""
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value) && value > 0) {
                        handleGlobalSpeed(value);
                      }
                      event.target.value = "";
                    }}
                  >
                    <option value="">×</option>
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
                      <option key={speed} value={speed}>
                        {speed}x
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondary-button" type="button" onClick={handleSelectAll} title="Select all clips">
                  All
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleSelectNone}
                  disabled={selectedIds.size === 0}
                  title="Clear selection"
                >
                  None
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setCompactView((current) => !current)}
                  title={compactView ? "Detailed view" : "Compact view"}
                  aria-label={compactView ? "Switch to detailed view" : "Switch to compact view"}
                  aria-pressed={compactView}
                >
                  {compactView ? <Eye aria-hidden="true" size={17} /> : <FileVideo aria-hidden="true" size={17} />}
                </button>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setTimelineFullscreen((current) => !current)}
                  title={timelineFullscreen ? "Exit full screen" : "Full screen timeline"}
                  aria-label={timelineFullscreen ? "Exit full screen timeline" : "Full screen timeline"}
                  aria-pressed={timelineFullscreen}
                >
                  {timelineFullscreen ? <Minimize2 aria-hidden="true" size={17} /> : <Maximize2 aria-hidden="true" size={17} />}
                </button>
                <button className="icon-button" type="button" onClick={() => handleClear()} title="Clear clips" aria-label="Clear clips">
                  <RotateCcw aria-hidden="true" size={18} />
                </button>
              </div>

              <div className="timeline-toolbar timeline-toolbar-secondary">
                <button className="secondary-button" type="button" onClick={handleExportCsv} title="Download clip metadata as CSV">
                  CSV
                </button>
                <button className="secondary-button" type="button" onClick={handleExportZip} title="Download project bundle (.zip)">
                  Project .zip
                </button>
                <button className="secondary-button" type="button" onClick={handleCopySummary} title="Copy a text summary to the clipboard">
                  Copy summary
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleContactSheet}
                  disabled={contactSheetBusy || readyItems.length === 0}
                  title="Export a grid of frame thumbnails as PNG"
                >
                  {contactSheetBusy ? <Loader2 className="spin" aria-hidden="true" size={15} /> : null}
                  Contact sheet
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setShowBin((current) => !current)}
                  disabled={deletedBin.length === 0 && !showBin}
                  title="Recently deleted clips"
                >
                  <Trash2 aria-hidden="true" size={15} />
                  Bin ({deletedBin.length})
                </button>
                <label className="confirm-toggle" title="Ask for confirmation before removing or clearing clips">
                  <input
                    type="checkbox"
                    checked={confirmDestructive}
                    onChange={(event) => setConfirmDestructive(event.target.checked)}
                  />
                  <span>Confirm deletes</span>
                </label>
              </div>

              {selectedIds.size > 0 && (
                <div className="bulk-actions-bar" role="toolbar" aria-label="Bulk clip actions">
                  <strong>{selectedIds.size} selected</strong>
                  <button type="button" className="secondary-button" onClick={handleBulkRotate}>
                    <RotateCw aria-hidden="true" size={15} />
                    Rotate
                  </button>
                  <button type="button" className="secondary-button" onClick={() => handleBulkMute(true)}>
                    Mute
                  </button>
                  <button type="button" className="secondary-button" onClick={() => handleBulkMute(false)}>
                    Unmute
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={handlePasteEffectsToSelected}
                    disabled={!effectsClipboard}
                    title="Paste copied effects onto the selected clips"
                  >
                    Paste effects
                  </button>
                  <button type="button" className="danger-button" onClick={handleBulkDelete}>
                    <Trash2 aria-hidden="true" size={15} />
                    Delete
                  </button>
                </div>
              )}

              {showBin && deletedBin.length > 0 && (
                <div className="deleted-bin" aria-label="Recently deleted clips">
                  <strong>Recently deleted</strong>
                  <ul>
                    {deletedBin.map((entry) => (
                      <li key={entry.id}>
                        <span>{entry.name}</span>
                        <button type="button" className="secondary-button" onClick={() => handleRestoreFromBin(entry.id)}>
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {showExtras && (
                <div className="extras-panel">
                  <div className="extras-field">
                    <span>Watermark</span>
                    {watermark ? (
                      <div className="extras-row">
                        <span className="extras-filename">{watermark.file.name}</span>
                        <label>
                          Opacity
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={watermark.opacity}
                            onChange={(event) => setWatermark({ ...watermark, opacity: Number(event.target.value) })}
                          />
                        </label>
                        <select
                          value={watermark.position}
                          aria-label="Watermark position"
                          onChange={(event) => setWatermark({ ...watermark, position: event.target.value as WatermarkPosition })}
                        >
                          <option value="top-left">Top left</option>
                          <option value="top-right">Top right</option>
                          <option value="bottom-left">Bottom left</option>
                          <option value="bottom-right">Bottom right</option>
                          <option value="center">Center</option>
                        </select>
                        <button type="button" className="icon-button" onClick={() => setWatermark(null)} aria-label="Remove watermark">
                          <X aria-hidden="true" size={16} />
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="secondary-button" onClick={() => watermarkInputRef.current?.click()}>
                        <ImageIcon aria-hidden="true" size={16} />
                        Add logo image
                      </button>
                    )}
                  </div>

                  <div className="extras-field">
                    <span>Background music</span>
                    {backgroundMusic ? (
                      <div className="extras-row">
                        <span className="extras-filename">{backgroundMusic.file.name}</span>
                        <label>
                          Volume
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={backgroundMusic.volume}
                            onChange={(event) => setBackgroundMusic({ ...backgroundMusic, volume: Number(event.target.value) })}
                          />
                        </label>
                        <button type="button" className="icon-button" onClick={() => setBackgroundMusic(null)} aria-label="Remove music">
                          <X aria-hidden="true" size={16} />
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="secondary-button" onClick={() => musicInputRef.current?.click()}>
                        <Music aria-hidden="true" size={16} />
                        Add music track
                      </button>
                    )}
                  </div>
                </div>
              )}

              {readyItems.length > 0 && (
                <div className="overview-scrubber" role="navigation" aria-label="Project overview">
                  {readyItems.map((item) => {
                    const share = totalDuration > 0 ? (clipOutputDuration(item) / totalDuration) * 100 : 0;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="overview-block"
                        style={{ width: `${Math.max(1.5, share)}%`, background: item.tagColor ?? undefined }}
                        title={`${item.name} (${formatDuration(clipOutputDuration(item))})`}
                        aria-label={`Jump to ${item.name}`}
                        onClick={() => {
                          document.getElementById(`clip-card-${item.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      />
                    );
                  })}
                </div>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={visibleItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                  <ol className={`clip-list ${compactView ? "is-compact" : ""}`}>
                    {visibleItems.map((item, index) => {
                      const realIndex = items.findIndex((entry) => entry.id === item.id);
                      return (
                      <li key={item.id} className="clip-list-entry">
                        {item.markerLabel && (
                          <div className="chapter-marker" role="note">
                            <span>{item.markerLabel}</span>
                          </div>
                        )}
                        <SortableClipCard
                          item={item}
                          index={realIndex}
                          compact={compactView}
                          isSelected={selectedIds.has(item.id)}
                          isDropTarget={dropIndex === realIndex}
                          onSelect={handleSelectItem}
                          onRemove={handleRemove}
                          onPreview={setPreviewingItem}
                          onRotate={handleRotate}
                          onDuplicate={handleDuplicate}
                          onToggleLock={handleToggleLock}
                          isRenaming={renamingId === item.id}
                          onStartRename={handleStartRename}
                          onCommitRename={handleRenameCommit}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setContextMenu({ x: event.clientX, y: event.clientY, itemId: item.id });
                          }}
                          onFileDragOver={(event) => {
                            if (event.dataTransfer.types.includes("Files")) {
                              event.preventDefault();
                              setDropIndex(realIndex);
                            }
                          }}
                        />
                        {!isFiltering && index < visibleItems.length - 1 && (
                          <div className="clip-gap">
                            <button
                              type="button"
                              className={`crossfade-toggle ${(item.crossfadeAfter ?? 0) > 0 ? "is-active" : ""}`}
                              onClick={() => handleToggleCrossfade(item.id)}
                              title="Toggle a crossfade transition into the next clip"
                              aria-pressed={(item.crossfadeAfter ?? 0) > 0}
                            >
                              {(item.crossfadeAfter ?? 0) > 0 ? "Crossfade" : "Cut"}
                            </button>
                            {(item.crossfadeAfter ?? 0) > 0 && (
                              <input
                                type="number"
                                className="crossfade-duration"
                                min={0.1}
                                max={5}
                                step={0.1}
                                value={item.crossfadeAfter}
                                onChange={(event) => handleCrossfadeDuration(item.id, Number(event.target.value))}
                                aria-label="Crossfade duration in seconds"
                              />
                            )}
                          </div>
                        )}
                      </li>
                      );
                    })}
                  </ol>
                </SortableContext>
              </DndContext>
              {isFiltering && visibleItems.length === 0 && <p className="filter-empty">No clips match “{filterText}”.</p>}
            </>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
            multiple
            hidden
            onChange={handleFileChange}
          />
          <input
            ref={sessionInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={handleLoadSession}
          />
          <input ref={watermarkInputRef} type="file" accept="image/*" hidden onChange={handleWatermarkFile} />
          <input ref={musicInputRef} type="file" accept="audio/*" hidden onChange={handleMusicFile} />
        </section>

        <aside className="merge-panel">
          <div className="merge-meter" aria-live="polite">
            <span>{statusLabel(status, hasBlockingItem)}</span>
            <strong>{progress ? `${Math.round(progress.ratio * 100)}%` : `${readyCount}/${items.length}`}</strong>
            <div className="progress-track">
              <div style={{ width: `${progress ? progress.ratio * 100 : items.length === 0 ? 0 : (readyCount / items.length) * 100}%` }} />
            </div>
            <p>{progress?.message ?? `${settings.width}x${settings.height} / ${settings.aspectLabel} / ${settings.fps}fps`}</p>
            {eta && <p className="eta-text">~{eta} remaining</p>}
            {estimatedBytes > 0 && (
              <p className="estimate-text" title="Rough estimate: bitrate × duration">
                ~{formatBytes(estimatedBytes)} est. / {formatDuration(totalDuration)}
              </p>
            )}
            <p className="backend-status">
              <Server aria-hidden="true" size={14} />
              {backendMessage}
            </p>
          </div>

          {error && <p className="error-text">{error}</p>}
          {errorLogRef.current.length > 0 && (
            <button type="button" className="secondary-button" onClick={handleExportErrorLog}>
              Export error log
            </button>
          )}

          <label className="output-name-field">
            <span>Output file name</span>
            <input
              type="text"
              value={settings.outputName}
              maxLength={120}
              onChange={(event) => setSettings({ ...settings, outputName: event.target.value })}
              onBlur={(event) => setSettings({ ...settings, outputName: sanitizeOutputName(event.target.value) })}
              aria-label="Output file name (without extension)"
            />
          </label>

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

            <button
              type="button"
              className="secondary-button"
              disabled={readyItems.length === 0 || status === "merging"}
              onClick={() => setShowCompositionPreview(true)}
              title="Play a fast in-browser approximation of the final composition"
            >
              <Eye aria-hidden="true" size={17} />
              Preview
            </button>

            <a
              className={`download-button ${downloadUrl ? "" : "is-disabled"}`}
              href={downloadUrl ?? undefined}
              download={`${sanitizeOutputName(settings.outputName)}.mp4`}
            >
              <Download aria-hidden="true" size={18} />
              Download
            </a>

            <button
              type="button"
              className="secondary-button"
              disabled={!downloadUrl || gifBusy}
              onClick={() => void handleExportGif()}
            >
              {gifBusy ? <Loader2 className="spin" aria-hidden="true" size={17} /> : <Film aria-hidden="true" size={17} />}
              Export as GIF
            </button>

            {gifUrl && (
              <a className="download-button" href={gifUrl} download={`${sanitizeOutputName(settings.outputName)}.gif`}>
                <Download aria-hidden="true" size={18} />
                Download GIF
              </a>
            )}
          </div>
        </aside>
      </section>
    </main>

    <ClipPreviewModal
      item={previewingItem}
      onClose={() => setPreviewingItem(null)}
      onCommitSegments={handleApplyClipEdit}
      onSplit={handleSplitClip}
      onRegeneratePoster={handleRegeneratePoster}
    />

    {showCompositionPreview && (
      <CompositionPreviewModal items={items} onClose={() => setShowCompositionPreview(false)} />
    )}

    {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

    <MissingClipsDialog
      missingClips={missingClips}
      onCancel={handleDismissMissing}
      onLocate={handleRelocateMissing}
      onLocateBulk={handleRelocateBulk}
    />

    {contextMenu && contextItem && (
      <div
        className="context-menu"
        role="menu"
        style={{
          left: Math.min(contextMenu.x, window.innerWidth - 240),
          top: Math.min(contextMenu.y, window.innerHeight - 420)
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong className="context-menu-title">{contextItem.name}</strong>
        <button type="button" role="menuitem" onClick={() => { setPreviewingItem(contextItem); setContextMenu(null); }}>
          Edit / preview
        </button>
        <button type="button" role="menuitem" onClick={() => { handleDuplicate(contextItem.id); setContextMenu(null); }}>
          Duplicate
        </button>
        <button type="button" role="menuitem" onClick={() => { handleRotate(contextItem.id); setContextMenu(null); }}>
          Rotate 90°
        </button>
        <button type="button" role="menuitem" onClick={() => { handleStartRename(contextItem.id); setContextMenu(null); }}>
          Rename
        </button>
        <button type="button" role="menuitem" onClick={() => { moveItemToIndex(contextItem.id, 0); setContextMenu(null); }}>
          Move to start
        </button>
        <button type="button" role="menuitem" onClick={() => { moveItemToIndex(contextItem.id, items.length - 1); setContextMenu(null); }}>
          Move to end
        </button>
        <button type="button" role="menuitem" onClick={() => { handleMoveToPosition(contextItem.id); setContextMenu(null); }}>
          Move to position…
        </button>
        <button type="button" role="menuitem" onClick={() => { handleToggleLock(contextItem.id); setContextMenu(null); }}>
          {contextItem.locked ? "Unlock" : "Lock"}
        </button>
        <button type="button" role="menuitem" onClick={() => { handleSetMarker(contextItem.id); setContextMenu(null); }}>
          Chapter marker…
        </button>
        <button type="button" role="menuitem" onClick={() => { handleSetTagText(contextItem.id); setContextMenu(null); }}>
          Tag text…
        </button>
        <button type="button" role="menuitem" onClick={() => { handleEditNote(contextItem.id); setContextMenu(null); }}>
          Note…
        </button>
        <div className="context-menu-tags" role="group" aria-label="Tag color">
          {TAG_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`tag-swatch ${contextItem.tagColor === color ? "is-active" : ""}`}
              style={{ background: color }}
              aria-label={`Tag color ${color}`}
              onClick={() => { handleSetTagColor(contextItem.id, color); setContextMenu(null); }}
            />
          ))}
          <button
            type="button"
            className="tag-swatch tag-swatch-clear"
            aria-label="Clear tag color"
            onClick={() => { handleSetTagColor(contextItem.id, undefined); setContextMenu(null); }}
          >
            <X aria-hidden="true" size={11} />
          </button>
        </div>
        <button type="button" role="menuitem" onClick={() => { handleCopyEffects(contextItem.id); setContextMenu(null); }}>
          Copy effects
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!effectsClipboard}
          onClick={() => { handlePasteEffects(contextItem.id); setContextMenu(null); }}
        >
          Paste effects
        </button>
        <button type="button" role="menuitem" disabled={!effectsClipboard} onClick={() => { handlePasteEffectsToAll(); setContextMenu(null); }}>
          Paste effects to all
        </button>
        <button type="button" role="menuitem" onClick={() => { handleResetEffects(contextItem.id); setContextMenu(null); }}>
          Reset effects
        </button>
        <button type="button" role="menuitem" className="context-menu-danger" onClick={() => { handleRemove(contextItem.id); setContextMenu(null); }}>
          Remove
        </button>
      </div>
    )}

    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          {toast.text}
        </div>
      ))}
    </div>
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

      <label>
        <span>FPS</span>
        <select
          value={settings.fps}
          disabled={disabled}
          aria-label="Output frame rate"
          onChange={(event) => onChange({ ...settings, fps: Number(event.target.value) })}
        >
          {[24, 25, 30, 60].map((fps) => (
            <option key={fps} value={fps}>
              {fps}
            </option>
          ))}
        </select>
      </label>

      <label title="Trades file size against visual quality (scales the target bitrate)">
        <span>Quality {settings.quality}</span>
        <input
          type="range"
          min={20}
          max={100}
          step={5}
          value={settings.quality}
          disabled={disabled}
          aria-label="Output quality"
          onChange={(event) => onChange({ ...settings, quality: Number(event.target.value) })}
        />
      </label>

      <label title="Master volume applied to the whole merged audio track">
        <span>Volume {Math.round(settings.masterVolume * 100)}%</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={settings.masterVolume}
          disabled={disabled}
          aria-label="Master output volume"
          onChange={(event) => onChange({ ...settings, masterVolume: Number(event.target.value) })}
        />
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
  compact,
  isSelected,
  isDropTarget,
  onSelect,
  onRemove,
  onPreview,
  onRotate,
  onDuplicate,
  onToggleLock,
  isRenaming,
  onStartRename,
  onCommitRename,
  onContextMenu,
  onFileDragOver
}: {
  item: VideoItem;
  index: number;
  compact: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  onSelect: (id: string, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  onRemove: (id: string) => void;
  onPreview: (item: VideoItem) => void;
  onRotate: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string) => void;
  isRenaming: boolean;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onFileDragOver: (event: DragEvent<HTMLElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const waveformRef = useRef<HTMLCanvasElement | null>(null);
  const scrubbingRef = useRef(false);
  const [renameValue, setRenameValue] = useState(item.name);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  // Draw the low-res waveform when peaks arrive or the theme-independent card re-renders.
  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || !item.waveform || item.waveform.length === 0) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(99, 132, 255, 0.75)";
    const barWidth = width / item.waveform.length;
    item.waveform.forEach((peak, barIndex) => {
      const barHeight = Math.max(1, peak * height);
      context.fillRect(barIndex * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
    });
  }, [item.waveform]);

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
    if (!video || scrubbingRef.current) {
      return;
    }
    video.pause();
    video.currentTime = 0;
  };

  const handleScrub = (event: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    const duration = item.metadata?.duration;
    if (!video || !duration || duration <= 0) {
      return;
    }
    scrubbingRef.current = true;
    video.pause();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
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
    <div
      ref={setNodeRef}
      id={`clip-card-${item.id}`}
      style={style}
      className={`clip-card ${isDragging ? "is-dragging" : ""} ${isSelected ? "is-selected" : ""} ${compact ? "is-compact" : ""} ${isDropTarget ? "is-drop-target" : ""} ${item.locked ? "is-locked" : ""}`}
      onContextMenu={onContextMenu}
      onDragOver={onFileDragOver}
      onClick={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          event.preventDefault();
          onSelect(item.id, event);
        }
      }}
    >
      <button className="drag-handle" type="button" title="Move clip" aria-label={`Move ${item.name}`} {...attributes} {...listeners}>
        <GripVertical aria-hidden="true" size={20} />
      </button>

      <button
        type="button"
        className="clip-index"
        title="Click to select (Shift for range, Ctrl/Cmd to toggle)"
        aria-label={`Select ${item.name}`}
        aria-pressed={isSelected}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(item.id, event);
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </button>

      <div
        className="preview-frame"
        onMouseEnter={canPreview ? playPreview : undefined}
        onMouseMove={canPreview ? handleScrub : undefined}
        onMouseLeave={
          canPreview
            ? () => {
                scrubbingRef.current = false;
                pausePreview();
              }
            : undefined
        }
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
          {item.tagColor && <span className="clip-tag-dot" style={{ background: item.tagColor }} title={item.tagText ?? "Tagged"} />}
          <FileVideo aria-hidden="true" size={17} />
          {isRenaming ? (
            <input
              className="clip-rename-input"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => onCommitRename(item.id, renameValue)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onCommitRename(item.id, renameValue);
                } else if (event.key === "Escape") {
                  setRenameValue(item.name);
                  onCommitRename(item.id, item.name);
                }
              }}
            />
          ) : (
            <strong onDoubleClick={() => onStartRename(item.id)} title="Double-click to rename">
              {item.name}
            </strong>
          )}
          {item.tagText && <span className="clip-tag-text">{item.tagText}</span>}
          {item.note && <StickyNote aria-hidden="true" size={14} className="clip-note-icon" aria-label="Has note" />}
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
        {item.note && <p className="clip-note" title={item.note}>{item.note}</p>}
        {item.waveform && item.waveform.length > 0 && !compact && (
          <canvas ref={waveformRef} className="clip-waveform" width={192} height={22} aria-hidden="true" />
        )}
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
        {item.speed !== 1 && <span>{item.speed}x</span>}
        {item.reversed && <span>rev</span>}
        {(item.freezeFrame ?? 0) > 0 && <span>freeze</span>}
        {item.textOverlay && <span>title</span>}
        {item.muted && <span>muted</span>}
      </div>

      <div className="clip-actions">
        <button
          className="icon-button"
          type="button"
          onClick={() => onToggleLock(item.id)}
          title={item.locked ? "Unlock clip" : "Lock clip"}
          aria-label={item.locked ? `Unlock ${item.name}` : `Lock ${item.name}`}
          aria-pressed={item.locked === true}
        >
          {item.locked ? <Lock aria-hidden="true" size={17} /> : <LockOpen aria-hidden="true" size={17} />}
        </button>

        <button
          className="icon-button"
          type="button"
          onClick={() => onRotate(item.id)}
          disabled={item.locked}
          title="Rotate 90°"
          aria-label={`Rotate ${item.name} 90°`}
          aria-pressed={item.rotation !== 0}
        >
          <RotateCw aria-hidden="true" size={18} />
        </button>

        <button
          className="icon-button"
          type="button"
          onClick={() => onDuplicate(item.id)}
          title="Duplicate clip"
          aria-label={`Duplicate ${item.name}`}
        >
          <Copy aria-hidden="true" size={18} />
        </button>

        <button
          className="icon-button"
          type="button"
          onClick={() => onRemove(item.id)}
          disabled={item.locked}
          title="Remove clip"
          aria-label={`Remove ${item.name}`}
        >
          <Trash2 aria-hidden="true" size={18} />
        </button>
      </div>
    </div>
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
