import { Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, isTransposed, rotationDegrees } from "../shared/mediaUtils";
import type { VideoItem } from "../shared/types";

const SCRUB_STEP_SECONDS = 5;

interface ClipPreviewModalProps {
  item: VideoItem | null;
  onClose: () => void;
}

export function ClipPreviewModal({ item, onClose }: ClipPreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const fallbackDuration = item?.metadata?.duration;

  useEffect(() => {
    if (item) {
      setCurrentTime(0);
      setDuration(fallbackDuration && Number.isFinite(fallbackDuration) ? fallbackDuration : 0);
      setIsPlaying(false);
    }
  }, [item, fallbackDuration]);

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
    setCurrentTime((value) => (videoRef.current?.currentTime ?? value));
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

  const seekTo = useCallback((nextTime: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const clamped = Math.min(Math.max(0, nextTime), duration > 0 ? duration : nextTime);
    video.currentTime = clamped;
    setCurrentTime(clamped);
  }, [duration]);

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

  const sliderProgress = useMemo(() => {
    if (duration <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
  }, [currentTime, duration]);

  if (!item) {
    return null;
  }

  const rotationDeg = rotationDegrees(item.rotation);
  const portrait = isTransposed(item.rotation);
  const videoStyle: React.CSSProperties = rotationDeg
    ? {
        transform: `rotate(${rotationDeg}deg)`,
        maxHeight: portrait ? "min(70vw, calc(100vh - 220px))" : "70vh",
        maxWidth: portrait ? "min(96vw, 540px)" : "100%"
      }
    : {};

  return (
    <div className="preview-modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className="preview-modal"
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
            max={duration > 0 ? duration : 0}
            step={0.01}
            value={Math.min(currentTime, duration > 0 ? duration : 0)}
            onChange={handleSliderChange}
            aria-label="Seek"
            style={{ ["--progress" as string]: `${sliderProgress}%` }}
          />

          <span className="preview-modal-time" aria-live="off">
            {formatDuration(currentTime)} / {formatDuration(duration > 0 ? duration : item.metadata?.duration)}
          </span>
        </div>
      </div>
    </div>
  );
}
