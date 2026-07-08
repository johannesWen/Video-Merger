import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clipOutputDuration, formatDuration, rotationDegrees } from "../shared/mediaUtils";
import { findNextKeptStart, findSegmentIndexAt, isTimeInKeptRegion, normalizeSegments } from "../shared/trimSegments";
import type { VideoItem } from "../shared/types";

interface CompositionPreviewModalProps {
  items: VideoItem[];
  onClose: () => void;
}

/**
 * Fast, no-render live preview of the current timeline: sequences the clips through a
 * single <video> element, honoring trim segments, speed (playbackRate), volume/mute,
 * rotation, CSS-approximated color adjustments, and fade in/out via an opacity overlay.
 * No FFmpeg work happens here.
 */
export function CompositionPreviewModal({ items, onClose }: CompositionPreviewModalProps) {
  const playable = useMemo(() => items.filter((item) => item.status === "ready" && item.metadata), [items]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [clipTime, setClipTime] = useState(0);
  const [fadeOpacity, setFadeOpacity] = useState(0);

  const current = playable[clipIndex];

  const segments = useMemo(() => {
    if (!current) {
      return [];
    }
    return normalizeSegments(current.trimSegments, current.metadata?.duration ?? 0);
  }, [current]);

  const clipDurations = useMemo(() => playable.map((item) => clipOutputDuration(item)), [playable]);
  const totalDuration = useMemo(() => clipDurations.reduce((sum, value) => sum + value, 0), [clipDurations]);

  const elapsedBefore = useMemo(
    () => clipDurations.slice(0, clipIndex).reduce((sum, value) => sum + value, 0),
    [clipDurations, clipIndex]
  );

  // Kept source-time elapsed within the current clip up to `time`, converted to output time via speed.
  const clipOutputElapsed = useCallback(
    (time: number) => {
      let kept = 0;
      for (const segment of segments) {
        if (time <= segment.start) {
          break;
        }
        kept += Math.min(time, segment.end) - segment.start;
      }
      const speed = current && current.speed > 0 ? current.speed : 1;
      return kept / speed;
    },
    [segments, current]
  );

  const overallElapsed = Math.min(totalDuration, elapsedBefore + clipOutputElapsed(clipTime));

  const advanceToNextClip = useCallback(() => {
    setClipIndex((index) => {
      if (index >= playable.length - 1) {
        setIsPlaying(false);
        return index;
      }
      return index + 1;
    });
    setClipTime(0);
  }, [playable.length]);

  // Apply per-clip playback properties whenever the active clip changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !current) {
      return;
    }
    video.playbackRate = Math.min(4, Math.max(0.25, current.speed));
    video.volume = Math.min(1, Math.max(0, current.volume));
    video.muted = current.muted;
    const firstSegment = normalizeSegments(current.trimSegments, current.metadata?.duration ?? 0)[0];
    video.currentTime = firstSegment ? firstSegment.start : 0;
    if (isPlaying) {
      void video.play().catch(() => setIsPlaying(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipIndex, current?.id]);

  // Trim-segment sequencing: skip removed regions, advance clips at the last kept segment's end.
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !current) {
      return;
    }
    const time = video.currentTime;
    setClipTime(time);

    if (segments.length === 0) {
      return;
    }

    if (!isTimeInKeptRegion(segments, time)) {
      const next = findNextKeptStart(segments, time);
      if (next !== undefined && Math.abs(next - time) > 1e-3) {
        video.currentTime = next;
        return;
      }
      if (next === undefined) {
        advanceToNextClip();
        return;
      }
    }

    const activeIndex = findSegmentIndexAt(segments, time);
    const active = segments[activeIndex];
    if (active && time >= active.end - 0.04) {
      const next = segments[activeIndex + 1];
      if (next) {
        video.currentTime = next.start;
      } else {
        advanceToNextClip();
      }
    }
  }, [advanceToNextClip, current, segments]);

  const handleEnded = useCallback(() => {
    advanceToNextClip();
  }, [advanceToNextClip]);

  // Fade in/out approximation via a black overlay whose opacity follows the clip-local output time.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video && current) {
        const outputElapsed = clipOutputElapsed(video.currentTime);
        const clipOut = clipDurations[clipIndex] ?? 0;
        let opacity = 0;
        const fadeIn = Math.min(current.fadeIn, clipOut / 2);
        const fadeOut = Math.min(current.fadeOut, clipOut / 2);
        if (fadeIn > 0.01 && outputElapsed < fadeIn) {
          opacity = Math.max(opacity, 1 - outputElapsed / fadeIn);
        }
        if (fadeOut > 0.01 && outputElapsed > clipOut - fadeOut) {
          opacity = Math.max(opacity, (outputElapsed - (clipOut - fadeOut)) / fadeOut);
        }
        setFadeOpacity(Math.min(1, Math.max(0, opacity)));
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [clipDurations, clipIndex, clipOutputElapsed, current]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      videoRef.current?.pause();
    };
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused || video.ended) {
      setIsPlaying(true);
      void video.play().catch(() => setIsPlaying(false));
    } else {
      setIsPlaying(false);
      video.pause();
    }
  }, []);

  const jumpClip = useCallback(
    (delta: number) => {
      setClipIndex((index) => Math.min(playable.length - 1, Math.max(0, index + delta)));
      setClipTime(0);
    },
    [playable.length]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        jumpClip(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        jumpClip(-1);
      }
    },
    [jumpClip, onClose, togglePlay]
  );

  if (playable.length === 0) {
    return null;
  }

  const rotation = current ? rotationDegrees(current.rotation) : 0;
  const color = current?.colorAdjust ?? { brightness: 0, contrast: 1, saturation: 1 };
  const cssFilter = `brightness(${(1 + color.brightness).toFixed(3)}) contrast(${color.contrast.toFixed(3)}) saturate(${color.saturation.toFixed(3)})`;
  const progressPercent = totalDuration > 0 ? (overallElapsed / totalDuration) * 100 : 0;

  return (
    <div
      className="preview-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="preview-modal composition-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composition-preview-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          className="preview-modal-close icon-button"
          onClick={onClose}
          aria-label="Close composition preview"
          title="Close"
        >
          <X aria-hidden="true" size={18} />
        </button>

        <h2 id="composition-preview-title" className="preview-modal-title">
          Composition preview
        </h2>
        <p className="composition-preview-sub">
          Live approximation of trims, speed, volume, fades and color — no export required.
          {current?.reversed ? " (Reversed clips play forward in this preview.)" : ""}
        </p>

        <div className="composition-preview-stage">
          <video
            key={current?.id}
            ref={videoRef}
            src={current?.objectUrl}
            playsInline
            preload="auto"
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleEnded}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            style={{
              filter: cssFilter,
              transform: rotation ? `rotate(${rotation}deg)` : undefined
            }}
          />
          <div className="composition-fade-overlay" style={{ opacity: fadeOpacity }} aria-hidden="true" />
        </div>

        <div className="composition-preview-info">
          <span>
            Clip {clipIndex + 1}/{playable.length}: <strong>{current?.name}</strong>
          </span>
          <span>
            {formatDuration(overallElapsed)} / {formatDuration(totalDuration)}
          </span>
        </div>

        <div className="progress-track composition-progress" aria-hidden="true">
          <div style={{ width: `${progressPercent}%` }} />
        </div>

        <div className="preview-modal-controls composition-controls">
          <button
            type="button"
            className="icon-button"
            onClick={() => jumpClip(-1)}
            disabled={clipIndex === 0}
            aria-label="Previous clip"
            title="Previous clip"
          >
            <SkipBack aria-hidden="true" size={17} />
          </button>
          <button
            type="button"
            className="preview-modal-play icon-button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause aria-hidden="true" size={18} /> : <Play aria-hidden="true" size={18} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => jumpClip(1)}
            disabled={clipIndex >= playable.length - 1}
            aria-label="Next clip"
            title="Next clip"
          >
            <SkipForward aria-hidden="true" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
