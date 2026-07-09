import { Pause, Play, Scissors, SplitSquareHorizontal, X } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  clampColorAdjust,
  clampFade,
  clampFreeze,
  clampSpeed,
  clampVolume,
  formatDuration,
  isTransposed,
  rotationDegrees
} from "../shared/mediaUtils";
import {
  defaultSegments,
  findNextKeptStart,
  findSegmentIndexAt,
  isPristine,
  isTimeInKeptRegion,
  normalizeSegments,
  removeSegment,
  splitAt,
  totalKeptDuration
} from "../shared/trimSegments";
import type { ClipEffectsPreset, ColorAdjust, TextOverlay, TextOverlayPosition, TrimSegment, VideoItem } from "../shared/types";

const SCRUB_STEP_SECONDS = 5;
const PRESETS_STORAGE_KEY = "video-merger-effect-presets";

export interface ClipEditResult {
  trimSegments: TrimSegment[];
  volume: number;
  muted: boolean;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  colorAdjust: ColorAdjust;
  reversed: boolean;
  freezeFrame: number;
  textOverlay?: TextOverlay;
  note?: string;
}

export function loadEffectPresets(): ClipEffectsPreset[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((entry) => entry && typeof entry === "object" && typeof (entry as ClipEffectsPreset).name === "string") as ClipEffectsPreset[]) : [];
  } catch {
    return [];
  }
}

function saveEffectPresets(presets: ClipEffectsPreset[]): void {
  window.localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets.slice(0, 24)));
}

interface ClipPreviewModalProps {
  item: VideoItem | null;
  onClose: () => void;
  onCommitSegments: (item: VideoItem, result: ClipEditResult) => void;
  onSplit: (item: VideoItem, atTime: number) => void;
  onRegeneratePoster?: (item: VideoItem, atTime: number) => void;
}

type DragState = {
  segmentIndex: number;
  edge: "start" | "end";
  pointerId: number;
} | null;

const TRACK_PADDING_PX = 8;

export function ClipPreviewModal({ item, onClose, onCommitSegments, onSplit, onRegeneratePoster }: ClipPreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localSegments, setLocalSegments] = useState<TrimSegment[]>([]);
  const [respectTrimOnPlay, setRespectTrimOnPlay] = useState(true);
  const [drag, setDrag] = useState<DragState>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [colorAdjust, setColorAdjust] = useState<ColorAdjust>({ brightness: 0, contrast: 1, saturation: 1 });
  const [reversed, setReversed] = useState(false);
  const [freezeFrame, setFreezeFrame] = useState(0);
  const [overlayText, setOverlayText] = useState("");
  const [overlayPosition, setOverlayPosition] = useState<TextOverlayPosition>("bottom");
  const [overlayFontSize, setOverlayFontSize] = useState(48);
  const [overlayColor, setOverlayColor] = useState("#ffffff");
  const [note, setNote] = useState("");
  const [snapToSecond, setSnapToSecond] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [showSafeZones, setShowSafeZones] = useState(false);
  const [presets, setPresets] = useState<ClipEffectsPreset[]>(() => loadEffectPresets());

  const fallbackDuration = item?.metadata?.duration;
  const sourceDuration = duration > 0 ? duration : fallbackDuration ?? 0;

  const seededItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (item) {
      setCurrentTime(0);
      const fd = fallbackDuration && Number.isFinite(fallbackDuration) ? fallbackDuration : 0;
      setDuration(fd);
      setIsPlaying(false);
      setRespectTrimOnPlay(true);
      setVolume(item.volume);
      setMuted(item.muted);
      setSpeed(item.speed);
      setFadeIn(item.fadeIn);
      setFadeOut(item.fadeOut);
      setColorAdjust(item.colorAdjust);
      setReversed(item.reversed === true);
      setFreezeFrame(item.freezeFrame ?? 0);
      setOverlayText(item.textOverlay?.text ?? "");
      setOverlayPosition(item.textOverlay?.position ?? "bottom");
      setOverlayFontSize(item.textOverlay?.fontSize ?? 48);
      setOverlayColor(item.textOverlay?.color ?? "#ffffff");
      setNote(item.note ?? "");
      setZoom(1);
      if (fd > 0) {
        setLocalSegments(normalizeSegments(item.trimSegments, fd));
        seededItemIdRef.current = item.id;
      } else {
        seededItemIdRef.current = null;
      }
    } else {
      seededItemIdRef.current = null;
    }
  }, [item, fallbackDuration]);

  useEffect(() => {
    if (!item) {
      return;
    }
    if (seededItemIdRef.current === item.id) {
      return;
    }
    if (sourceDuration <= 0) {
      return;
    }
    setLocalSegments(normalizeSegments(item.trimSegments, sourceDuration));
    seededItemIdRef.current = item.id;
  }, [item, sourceDuration]);

  useEffect(() => {
    if (!item) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      const video = videoRef.current;
      if (video) {
        video.pause();
      }
    };
  }, [item]);

  useEffect(() => {
    if (!item) {
      return;
    }

    document.querySelectorAll<HTMLVideoElement>(".preview-frame video").forEach((video) => {
      video.pause();
    });
  }, [item]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }
  }, []);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    setCurrentTime(video.currentTime);
  }, []);

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => setIsPlaying(false), []);
  const handleEnded = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused || video.ended) {
      video.play().catch(() => {
        // A near-simultaneous pause() rejects the play() promise; ignore.
      });
    } else {
      video.pause();
    }
  }, []);

  const seekTo = useCallback(
    (nextTime: number) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const clamped = Math.min(Math.max(0, nextTime), sourceDuration > 0 ? sourceDuration : nextTime);
      video.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [sourceDuration]
  );

  const handleSliderChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      seekTo(Number(event.target.value));
    },
    [seekTo]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(currentTime - SCRUB_STEP_SECONDS);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTo(currentTime + SCRUB_STEP_SECONDS);
      }
    },
    [currentTime, onClose, seekTo, togglePlay]
  );

  const handleBackdropMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const [setTrackRef, trackWidth] = useElementWidth(trackRef);

  const pointerToTime = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || sourceDuration <= 0) {
        return 0;
      }
      const rect = track.getBoundingClientRect();
      const innerWidth = Math.max(1, (rect.width - TRACK_PADDING_PX * 2) * zoom);
      const relative = Math.min(Math.max(0, clientX - rect.left + track.scrollLeft - TRACK_PADDING_PX), innerWidth);
      return (relative / innerWidth) * sourceDuration;
    },
    [sourceDuration, zoom]
  );

  const handleSegmentEdgePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, segmentIndex: number, edge: "start" | "end") => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDrag({ segmentIndex, edge, pointerId: event.pointerId });
    },
    []
  );

  useEffect(() => {
    if (!drag) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) {
        return;
      }
      const rawTime = pointerToTime(event.clientX);
      const time = snapToSecond ? Math.min(sourceDuration, Math.max(0, Math.round(rawTime))) : rawTime;
      setLocalSegments((current) => {
        if (drag.edge === "start") {
          return moveStart(current, drag.segmentIndex, time, sourceDuration);
        }
        return moveEnd(current, drag.segmentIndex, time, sourceDuration);
      });
    };

    const handleUp = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) {
        return;
      }
      setDrag(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [drag, pointerToTime, snapToSecond, sourceDuration]);

  // Fine trim nudging with arrow keys while a trim handle has keyboard focus.
  const handleNudgeEdge = useCallback(
    (segmentIndex: number, edge: "start" | "end", delta: number) => {
      const step = snapToSecond ? Math.sign(delta) * 1 : delta;
      setLocalSegments((current) => {
        const segment = current[segmentIndex];
        if (!segment) {
          return current;
        }
        if (edge === "start") {
          return moveStart(current, segmentIndex, segment.start + step, sourceDuration);
        }
        return moveEnd(current, segmentIndex, segment.end + step, sourceDuration);
      });
    },
    [snapToSecond, sourceDuration]
  );

  useEffect(() => {
    if (!respectTrimOnPlay || !isPlaying || localSegments.length === 0 || sourceDuration <= 0) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const time = video.currentTime;

    if (!isTimeInKeptRegion(localSegments, time)) {
      const next = findNextKeptStart(localSegments, time);
      if (next !== undefined && Math.abs(next - time) > 1e-3) {
        video.currentTime = next;
      } else {
        video.pause();
      }
      return;
    }

    const activeIndex = findSegmentIndexAt(localSegments, time);
    const active = localSegments[activeIndex];
    if (!active) {
      return;
    }
    if (time >= active.end - 1e-3) {
      const next = localSegments[activeIndex + 1];
      if (next) {
        video.currentTime = next.start;
      } else {
        video.pause();
      }
    }
  }, [currentTime, isPlaying, localSegments, respectTrimOnPlay, sourceDuration]);

  const handleCutAtPlayhead = useCallback(() => {
    if (sourceDuration <= 0 || localSegments.length === 0) {
      return;
    }
    setLocalSegments((current) => splitAt(current, currentTime));
  }, [currentTime, localSegments, sourceDuration]);

  const handleRemoveSegment = useCallback((index: number) => {
    setLocalSegments((current) => removeSegment(current, index));
  }, []);

  const handleReset = useCallback(() => {
    if (sourceDuration <= 0) {
      return;
    }
    setLocalSegments(defaultSegments(sourceDuration));
    seekTo(0);
  }, [seekTo, sourceDuration]);

  const handleApply = useCallback(() => {
    if (!item) {
      return;
    }
    const trimmedText = overlayText.trim();
    onCommitSegments(item, {
      trimSegments: localSegments,
      volume: clampVolume(volume),
      muted,
      speed: clampSpeed(speed),
      fadeIn: clampFade(fadeIn),
      fadeOut: clampFade(fadeOut),
      colorAdjust: clampColorAdjust(colorAdjust),
      reversed,
      freezeFrame: clampFreeze(freezeFrame),
      textOverlay:
        trimmedText.length > 0
          ? {
              text: trimmedText.slice(0, 200),
              position: overlayPosition,
              fontSize: Math.min(200, Math.max(10, overlayFontSize)),
              color: overlayColor
            }
          : undefined,
      note: note.trim().length > 0 ? note.trim() : undefined
    });
    onClose();
  }, [colorAdjust, fadeIn, fadeOut, freezeFrame, item, localSegments, muted, note, onClose, onCommitSegments, overlayColor, overlayFontSize, overlayPosition, overlayText, reversed, speed, volume]);

  const handleSavePreset = useCallback(() => {
    const name = window.prompt("Preset name?");
    if (!name || name.trim().length === 0) {
      return;
    }
    const preset: ClipEffectsPreset = {
      name: name.trim().slice(0, 40),
      volume: clampVolume(volume),
      muted,
      speed: clampSpeed(speed),
      fadeIn: clampFade(fadeIn),
      fadeOut: clampFade(fadeOut),
      colorAdjust: clampColorAdjust(colorAdjust)
    };
    setPresets((current) => {
      const next = [...current.filter((entry) => entry.name !== preset.name), preset];
      saveEffectPresets(next);
      return next;
    });
  }, [colorAdjust, fadeIn, fadeOut, muted, speed, volume]);

  const handleApplyPreset = useCallback(
    (name: string) => {
      const preset = presets.find((entry) => entry.name === name);
      if (!preset) {
        return;
      }
      setVolume(preset.volume);
      setMuted(preset.muted);
      setSpeed(preset.speed);
      setFadeIn(preset.fadeIn);
      setFadeOut(preset.fadeOut);
      setColorAdjust({ ...preset.colorAdjust });
    },
    [presets]
  );

  const handleDeletePreset = useCallback((name: string) => {
    setPresets((current) => {
      const next = current.filter((entry) => entry.name !== name);
      saveEffectPresets(next);
      return next;
    });
  }, []);

  const handleSplitHere = useCallback(() => {
    if (!item || currentTime <= 0 || currentTime >= sourceDuration) {
      return;
    }
    onSplit(item, currentTime);
    onClose();
  }, [currentTime, item, onClose, onSplit, sourceDuration]);

  const pristine = isPristine(localSegments, sourceDuration);
  const keptDuration = totalKeptDuration(localSegments);
  const removedDuration = Math.max(0, sourceDuration - keptDuration);
  const cutCount = Math.max(0, localSegments.length - 1);
  const sliderProgress = useMemo(() => {
    if (sourceDuration <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (currentTime / sourceDuration) * 100));
  }, [currentTime, sourceDuration]);

  if (!item) {
    return null;
  }

  const rotationDeg = rotationDegrees(item.rotation);
  const portrait = isTransposed(item.rotation);
  const videoStyle: React.CSSProperties = rotationDeg
    ? {
        transform: `rotate(${rotationDeg}deg)`,
        maxHeight: portrait ? "min(70vw, calc(100vh - 360px))" : "55vh",
        maxWidth: portrait ? "min(96vw, 540px)" : "100%"
      }
    : { maxHeight: "55vh" };

  return (
    <div className="preview-modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="preview-modal preview-modal-trim"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clip-preview-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          className="preview-modal-close icon-button"
          onClick={onClose}
          aria-label="Close preview"
          title="Close preview"
        >
          <X aria-hidden="true" size={18} />
        </button>

        <h2 id="clip-preview-title" className="preview-modal-title">
          {item.name}
        </h2>

        <div className="preview-video-stage">
          <video
            key={item.id}
            ref={videoRef}
            className="preview-modal-video"
            src={item.objectUrl}
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={handlePlay}
            onPause={handlePause}
            onEnded={handleEnded}
            style={videoStyle}
          />
          {showSafeZones && (
            <div className="safe-zone-overlay" aria-hidden="true">
              <div className="safe-zone safe-zone-action" title="Action safe (90%)" />
              <div className="safe-zone safe-zone-title" title="Title safe (80%)" />
              <div className="safe-zone-center-v" />
              <div className="safe-zone-center-h" />
            </div>
          )}
        </div>

        <div className="preview-modal-controls">
          <button
            type="button"
            className="preview-modal-play icon-button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause aria-hidden="true" size={18} /> : <Play aria-hidden="true" size={18} />}
          </button>

          <input
            type="range"
            className="preview-modal-slider"
            min={0}
            max={sourceDuration > 0 ? sourceDuration : 0}
            step={0.01}
            value={Math.min(currentTime, sourceDuration > 0 ? sourceDuration : 0)}
            onChange={handleSliderChange}
            aria-label="Seek"
            style={{ ["--progress" as string]: `${sliderProgress}%` }}
          />

          <span className="preview-modal-time" aria-live="off">
            {formatDuration(currentTime)} / {formatDuration(sourceDuration > 0 ? sourceDuration : item.metadata?.duration)}
          </span>
        </div>

        <TrimEditor
          sourceDuration={sourceDuration}
          segments={localSegments}
          currentTime={currentTime}
          onSeek={seekTo}
          trackRef={setTrackRef}
          trackWidth={trackWidth}
          pointerToTime={pointerToTime}
          onEdgePointerDown={handleSegmentEdgePointerDown}
          onRemoveSegment={handleRemoveSegment}
          zoom={zoom}
          onNudgeEdge={handleNudgeEdge}
        />

        <div className="trim-summary">
          <span>Original {formatDuration(sourceDuration)}</span>
          <span>Kept {formatDuration(keptDuration)}</span>
          <span>Removed {formatDuration(removedDuration)}</span>
          <span>{cutCount} cut{cutCount === 1 ? "" : "s"}</span>
        </div>

        <div className="trim-toolbar">
          <button
            type="button"
            className="secondary-button"
            onClick={handleCutAtPlayhead}
            disabled={localSegments.length === 0 || sourceDuration <= 0}
          >
            <Scissors aria-hidden="true" size={16} />
            Cut here
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleSplitHere}
            disabled={sourceDuration <= 0 || currentTime <= 0 || currentTime >= sourceDuration}
            title="Split into two separate clips at the playhead"
          >
            <SplitSquareHorizontal aria-hidden="true" size={16} />
            Split clip
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={handleReset}
            disabled={pristine || sourceDuration <= 0}
          >
            Reset
          </button>
          <label className="trim-toggle">
            <input
              type="checkbox"
              checked={respectTrimOnPlay}
              onChange={(event) => setRespectTrimOnPlay(event.target.checked)}
            />
            <span>Skip cuts while playing</span>
          </label>
          <label className="trim-toggle">
            <input
              type="checkbox"
              checked={snapToSecond}
              onChange={(event) => setSnapToSecond(event.target.checked)}
            />
            <span>Snap to seconds</span>
          </label>
          <label className="trim-toggle">
            <input
              type="checkbox"
              checked={showSafeZones}
              onChange={(event) => setShowSafeZones(event.target.checked)}
            />
            <span>Safe zones</span>
          </label>
          <label className="trim-zoom">
            <span>Zoom {zoom}x</span>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              aria-label="Trim timeline zoom"
            />
          </label>
          {onRegeneratePoster && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onRegeneratePoster(item, currentTime)}
              disabled={sourceDuration <= 0}
              title="Use the current frame as this clip's thumbnail"
            >
              Set thumbnail
            </button>
          )}
        </div>

        <div className="effects-panel">
          <label className="effects-field">
            <span>Volume {Math.round(volume * 100)}%</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={volume}
              disabled={muted}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
          <label className="effects-toggle">
            <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
            <span>Mute</span>
          </label>
          <label className="effects-field">
            <span>Speed {speed.toFixed(2)}x</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            />
          </label>
          <label className="effects-field">
            <span>Fade in {fadeIn.toFixed(1)}s</span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={fadeIn}
              onChange={(event) => setFadeIn(Number(event.target.value))}
            />
          </label>
          <label className="effects-field">
            <span>Fade out {fadeOut.toFixed(1)}s</span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={fadeOut}
              onChange={(event) => setFadeOut(Number(event.target.value))}
            />
          </label>
          <label className="effects-field">
            <span>Brightness {colorAdjust.brightness.toFixed(2)}</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={colorAdjust.brightness}
              onChange={(event) => setColorAdjust({ ...colorAdjust, brightness: Number(event.target.value) })}
            />
          </label>
          <label className="effects-field">
            <span>Contrast {colorAdjust.contrast.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={colorAdjust.contrast}
              onChange={(event) => setColorAdjust({ ...colorAdjust, contrast: Number(event.target.value) })}
            />
          </label>
          <label className="effects-field">
            <span>Saturation {colorAdjust.saturation.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={colorAdjust.saturation}
              onChange={(event) => setColorAdjust({ ...colorAdjust, saturation: Number(event.target.value) })}
            />
          </label>
          <label className="effects-toggle">
            <input type="checkbox" checked={reversed} onChange={(event) => setReversed(event.target.checked)} />
            <span>Reverse playback</span>
          </label>
          <label className="effects-field">
            <span>Freeze last frame {freezeFrame.toFixed(1)}s</span>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={freezeFrame}
              onChange={(event) => setFreezeFrame(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="overlay-panel">
          <label className="overlay-field overlay-field-text">
            <span>Title text (burned in)</span>
            <input
              type="text"
              value={overlayText}
              maxLength={200}
              placeholder="Leave empty for no overlay"
              onChange={(event) => setOverlayText(event.target.value)}
            />
          </label>
          <label className="overlay-field">
            <span>Position</span>
            <select
              value={overlayPosition}
              onChange={(event) => setOverlayPosition(event.target.value as TextOverlayPosition)}
            >
              <option value="top">Top</option>
              <option value="center">Center</option>
              <option value="bottom">Bottom</option>
            </select>
          </label>
          <label className="overlay-field">
            <span>Size</span>
            <input
              type="number"
              min={10}
              max={200}
              value={overlayFontSize}
              onChange={(event) => setOverlayFontSize(Number(event.target.value))}
              aria-label="Overlay font size"
            />
          </label>
          <label className="overlay-field">
            <span>Color</span>
            <input
              type="color"
              value={overlayColor}
              onChange={(event) => setOverlayColor(event.target.value)}
              aria-label="Overlay text color"
            />
          </label>
        </div>

        <div className="preset-panel">
          <button type="button" className="secondary-button" onClick={handleSavePreset}>
            Save effects preset
          </button>
          {presets.length > 0 && (
            <>
              <label className="overlay-field">
                <span>Apply preset</span>
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) {
                      handleApplyPreset(event.target.value);
                    }
                  }}
                  aria-label="Apply saved effects preset"
                >
                  <option value="">Choose…</option>
                  {presets.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="overlay-field">
                <span>Delete preset</span>
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) {
                      handleDeletePreset(event.target.value);
                    }
                  }}
                  aria-label="Delete saved effects preset"
                >
                  <option value="">Choose…</option>
                  {presets.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="overlay-field overlay-field-text">
            <span>Notes</span>
            <input
              type="text"
              value={note}
              maxLength={500}
              placeholder="Private note about this clip"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </div>

        <div className="trim-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={handleApply}
            disabled={localSegments.length === 0 || sourceDuration <= 0}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function TrimEditor({
  sourceDuration,
  segments,
  currentTime,
  onSeek,
  trackRef,
  trackWidth,
  pointerToTime,
  onEdgePointerDown,
  onRemoveSegment,
  zoom = 1,
  onNudgeEdge
}: {
  sourceDuration: number;
  segments: TrimSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  trackRef: React.RefCallback<HTMLDivElement>;
  trackWidth: number;
  pointerToTime: (clientX: number) => number;
  onEdgePointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    segmentIndex: number,
    edge: "start" | "end"
  ) => void;
  onRemoveSegment: (index: number) => void;
  zoom?: number;
  onNudgeEdge?: (segmentIndex: number, edge: "start" | "end", delta: number) => void;
}) {
  const innerWidth = Math.max(0, (trackWidth - TRACK_PADDING_PX * 2) * zoom);

  const handleEdgeKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    segmentIndex: number,
    edge: "start" | "end"
  ) => {
    if (!onNudgeEdge) {
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      onNudgeEdge(segmentIndex, edge, event.shiftKey ? -1 : -0.1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      onNudgeEdge(segmentIndex, edge, event.shiftKey ? 1 : 0.1);
    }
  };
  const xForTime = useCallback(
    (time: number) => {
      if (sourceDuration <= 0) {
        return 0;
      }
      return (Math.min(Math.max(0, time), sourceDuration) / sourceDuration) * innerWidth;
    },
    [innerWidth, sourceDuration]
  );

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      onSeek(pointerToTime(event.clientX));
    },
    [onSeek, pointerToTime]
  );

  const handleSegmentPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      onSeek(pointerToTime(event.clientX));
    },
    [onSeek, pointerToTime]
  );

  if (sourceDuration <= 0) {
    return (
      <div className="trim-editor">
        <div className="trim-track" ref={trackRef}>
          <div className="trim-track-inner" style={{ width: 0 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="trim-editor">
      <div
        className="trim-track"
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        role="presentation"
      >
        <div className="trim-track-inner" style={{ width: innerWidth }}>
          {segments.map((segment, index) => {
            const left = xForTime(segment.start);
            const width = Math.max(2, xForTime(segment.end) - left);
            return (
              <div
                key={`${index}-${segment.start}-${segment.end}`}
                className="trim-segment"
                style={{ left, width }}
                onPointerDown={handleSegmentPointerDown}
              >
                {index === 0 && (
                  <div
                    className="trim-handle trim-handle-start"
                    onPointerDown={(event) => onEdgePointerDown(event, index, "start")}
                    onKeyDown={(event) => handleEdgeKeyDown(event, index, "start")}
                    role="slider"
                    aria-label="Trim start"
                    aria-valuemin={0}
                    aria-valuemax={segment.end}
                    aria-valuenow={segment.start}
                    tabIndex={0}
                  />
                )}
                <div
                  className="trim-handle trim-handle-end"
                  onPointerDown={(event) => onEdgePointerDown(event, index, "end")}
                  onKeyDown={(event) => handleEdgeKeyDown(event, index, "end")}
                  role="slider"
                  aria-label={index === segments.length - 1 ? "Trim end" : "Cut"}
                  aria-valuemin={segment.start}
                  aria-valuemax={sourceDuration}
                  aria-valuenow={segment.end}
                  tabIndex={0}
                />
              </div>
            );
          })}
          <div
            className="trim-playhead"
            style={{ left: xForTime(currentTime) }}
            aria-hidden="true"
          />
        </div>
      </div>

      <ol className="trim-segments-list">
        {segments.map((segment, index) => (
          <li key={`${index}-${segment.start}-${segment.end}`} className="trim-segment-row">
            <span className="trim-segment-index">#{index + 1}</span>
            <span className="trim-segment-range">
              {formatDuration(segment.start)} – {formatDuration(segment.end)}
            </span>
            <span className="trim-segment-length">{formatDuration(segment.end - segment.start)}</span>
            {index < segments.length - 1 && (
              <button
                type="button"
                className="trim-segment-remove"
                onClick={() => onRemoveSegment(index)}
                aria-label={`Remove segment ${index + 1} from output`}
                title="Remove this segment"
              >
                <X aria-hidden="true" size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function useElementWidth(
  externalRef?: React.MutableRefObject<HTMLElement | null>
): [React.RefCallback<HTMLElement>, number] {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);

  const update = useCallback(() => {
    if (elementRef.current) {
      setWidth(elementRef.current.getBoundingClientRect().width);
    }
  }, []);

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      elementRef.current = node;
      if (externalRef) {
        externalRef.current = node;
      }
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (node) {
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        observerRef.current = observer;
        window.addEventListener("resize", update);
      } else {
        window.removeEventListener("resize", update);
      }
    },
    [externalRef, update]
  );

  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      window.removeEventListener("resize", update);
    };
  }, [update]);

  return [setRef, width];
}

function moveStart(
  segments: TrimSegment[],
  index: number,
  requested: number,
  duration: number
): TrimSegment[] {
  if (index < 0 || index >= segments.length) {
    return segments;
  }
  const previousEnd = index === 0 ? 0 : segments[index - 1].end;
  const maxStart = Math.max(previousEnd, segments[index].end - 0.01);
  const clamped = Math.min(Math.max(requested, previousEnd), maxStart);
  if (Math.abs(clamped - segments[index].start) < 1e-3) {
    return segments;
  }
  return segments.map((segment, current) =>
    current === index ? { start: clamped, end: Math.min(segment.end, duration) } : segment
  );
}

function moveEnd(
  segments: TrimSegment[],
  index: number,
  requested: number,
  duration: number
): TrimSegment[] {
  if (index < 0 || index >= segments.length) {
    return segments;
  }
  const minEnd = segments[index].start + 0.01;
  const maxEnd = index === segments.length - 1 ? duration : segments[index + 1].start;
  const clamped = Math.max(Math.min(requested, maxEnd), minEnd);
  if (Math.abs(clamped - segments[index].end) < 1e-3) {
    return segments;
  }
  return segments.map((segment, current) =>
    current === index ? { start: segment.start, end: clamped } : segment
  );
}
