import { Pause, Play, Scissors, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { formatDuration, isTransposed, rotationDegrees } from "../shared/mediaUtils";
import {
  defaultSegments,
  findNextKeptStart,
  findSegmentIndexAt,
  isPristine,
  isTimeInKeptRegion,
  joinWithNext,
  normalizeSegments,
  removeSegment,
  splitAt,
  totalKeptDuration
} from "../shared/trimSegments";
import type { TrimSegment, VideoItem } from "../shared/types";

const SCRUB_STEP_SECONDS = 5;

interface ClipPreviewModalProps {
  item: VideoItem | null;
  onClose: () => void;
  onCommitSegments: (item: VideoItem, segments: TrimSegment[]) => void;
}

type DragState = {
  segmentIndex: number;
  edge: "start" | "end";
  pointerId: number;
} | null;

const TRACK_PADDING_PX = 8;

export function ClipPreviewModal({ item, onClose, onCommitSegments }: ClipPreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localSegments, setLocalSegments] = useState<TrimSegment[]>([]);
  const [respectTrimOnPlay, setRespectTrimOnPlay] = useState(true);
  const [drag, setDrag] = useState<DragState>(null);

  const fallbackDuration = item?.metadata?.duration;
  const sourceDuration = duration > 0 ? duration : fallbackDuration ?? 0;

  useEffect(() => {
    if (item) {
      setCurrentTime(0);
      setDuration(fallbackDuration && Number.isFinite(fallbackDuration) ? fallbackDuration : 0);
      setIsPlaying(false);
      setRespectTrimOnPlay(true);
    }
  }, [item, fallbackDuration]);

  const seededItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!item) {
      seededItemIdRef.current = null;
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
      void video.play();
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

  const trackWidth = useElementWidth(trackRef);

  const pointerToTime = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || sourceDuration <= 0) {
        return 0;
      }
      const rect = track.getBoundingClientRect();
      const innerWidth = Math.max(1, rect.width - TRACK_PADDING_PX * 2);
      const relative = Math.min(Math.max(0, clientX - rect.left - TRACK_PADDING_PX), innerWidth);
      return (relative / innerWidth) * sourceDuration;
    },
    [sourceDuration]
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
      const time = pointerToTime(event.clientX);
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
  }, [drag, pointerToTime, sourceDuration]);

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
    setLocalSegments((current) => joinWithNext(current, index));
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
    onCommitSegments(item, localSegments);
    onClose();
  }, [item, localSegments, onClose, onCommitSegments]);

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

        <video
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
          trackRef={trackRef}
          trackWidth={trackWidth}
          pointerToTime={pointerToTime}
          onEdgePointerDown={handleSegmentEdgePointerDown}
          onRemoveSegment={handleRemoveSegment}
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
  onRemoveSegment
}: {
  sourceDuration: number;
  segments: TrimSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  trackRef: React.RefObject<HTMLDivElement>;
  trackWidth: number;
  pointerToTime: (clientX: number) => number;
  onEdgePointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    segmentIndex: number,
    edge: "start" | "end"
  ) => void;
  onRemoveSegment: (index: number) => void;
}) {
  const innerWidth = Math.max(0, trackWidth - TRACK_PADDING_PX * 2);
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
                aria-label={`Merge segment ${index + 1} with the next`}
                title="Merge with next"
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

function useElementWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref]);

  return width;
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
