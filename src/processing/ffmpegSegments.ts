import type { OutputSettings, TextOverlayPosition, TrimSegment, VideoItem } from "../shared/types";
import { effectiveDuration, normalizeSegments } from "../shared/trimSegments";
import { buildLabeledVideoFilter } from "./ffmpegFilters";

const MIN_FADE_SECONDS = 0.01;

export interface SegmentArgOptions {
  /** Path to a pre-rendered transparent PNG (already sized to the output resolution) burned in as a text/title overlay. */
  textOverlayPath?: string;
}

export function createSegmentArgs(
  inputPath: string,
  outputPath: string,
  item: VideoItem,
  settings: OutputSettings,
  options: SegmentArgOptions = {}
): string[] {
  const rawDuration = item.metadata?.duration ?? 0.1;
  const hasAudio = item.metadata?.hasAudio === true;
  const videoBitrate = getVideoBitrate(settings);
  const trimSegments = normalizeSegments(item.trimSegments, rawDuration);
  const outputDuration = segmentOutputDuration(item, trimSegments);
  const silentDuration = Math.max(0.1, outputDuration).toFixed(3);
  const silentAudioInput = ["-f", "lavfi", "-t", silentDuration, "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
  const overlayInput = options.textOverlayPath ? ["-i", options.textOverlayPath] : [];
  const overlayInputIndex = options.textOverlayPath ? (hasAudio ? 1 : 2) : undefined;

  return [
    "-i",
    inputPath,
    ...(hasAudio ? [] : silentAudioInput),
    ...overlayInput,
    "-filter_complex",
    buildSegmentFilter(settings, item, trimSegments, hasAudio, overlayInputIndex),
    "-map",
    "[v]",
    "-map",
    "[ac]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    `${parseInt(videoBitrate, 10) * 2}k`,
    "-profile:v",
    "high",
    "-level:v",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    hasAudio ? "160k" : "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-shortest",
    "-f",
    "mpegts",
    "-mpegts_flags",
    "+resend_headers",
    "-bsf:v",
    "h264_mp4toannexb",
    outputPath
  ];
}

/** Output duration of a single normalized segment: kept time adjusted for speed, plus freeze-frame hold. */
export function segmentOutputDuration(item: VideoItem, trimSegments?: TrimSegment[]): number {
  const segments = trimSegments ?? normalizeSegments(item.trimSegments, item.metadata?.duration ?? 0.1);
  const kept = effectiveDuration({ metadata: item.metadata, trimSegments: segments });
  const speed = item.speed > 0 ? item.speed : 1;
  return kept / speed + Math.max(0, item.freezeFrame ?? 0);
}

export function getVideoBitrate(settings: OutputSettings): string {
  const pixels = settings.width * settings.height;

  let base: number;
  if (pixels >= 1920 * 1080) {
    base = 4500;
  } else if (pixels >= 1280 * 720) {
    base = 2800;
  } else {
    base = 1800;
  }

  const quality = Number.isFinite(settings.quality) ? Math.min(100, Math.max(20, settings.quality)) : 60;
  const scaled = Math.max(500, Math.round((base * quality) / 60));

  return `${scaled}k`;
}

export function createRemuxSegmentsArgs(segmentPaths: string[], outputPath: string): string[] {
  return [
    "-protocol_whitelist",
    "file,concat",
    "-i",
    `concat:${segmentPaths.join("|")}`,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-movflags",
    "+faststart",
    outputPath
  ];
}

export interface CrossfadeSegment {
  path: string;
  /** Output duration of this already-encoded segment in seconds. */
  duration: number;
  /** Crossfade into the NEXT segment, seconds (0 = hard cut). */
  crossfadeAfter: number;
}

/**
 * Joins pre-normalized segments with per-gap crossfades (xfade + acrossfade).
 * Gaps with crossfadeAfter=0 are joined with plain concat. Requires one re-encode pass.
 */
export function createCrossfadeConcatArgs(
  segments: CrossfadeSegment[],
  outputPath: string,
  settings: OutputSettings
): string[] {
  if (segments.length < 2) {
    throw new Error("Crossfade concat requires at least two segments.");
  }

  const inputs = segments.flatMap((segment) => ["-i", segment.path]);
  const parts: string[] = [];
  let videoLabel = "[0:v]";
  let audioLabel = "[0:a]";
  let accumulated = Math.max(0.1, segments[0].duration);

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const currentDuration = Math.max(0.1, current.duration);
    const requestedFade = Math.max(0, previous.crossfadeAfter);
    const fade = Math.min(requestedFade, Math.max(0, accumulated - 0.05), Math.max(0, currentDuration - 0.05));
    const stepVideo = `[vx${index}]`;
    const stepAudio = `[ax${index}]`;

    if (fade >= MIN_FADE_SECONDS) {
      const offset = Math.max(0, accumulated - fade);
      parts.push(
        `${videoLabel}[${index}:v]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}${stepVideo}`
      );
      parts.push(`${audioLabel}[${index}:a]acrossfade=d=${fade.toFixed(3)}${stepAudio}`);
      accumulated = offset + currentDuration;
    } else {
      parts.push(`${videoLabel}${audioLabel}[${index}:v][${index}:a]concat=n=2:v=1:a=1${stepVideo}${stepAudio}`);
      accumulated += currentDuration;
    }

    videoLabel = stepVideo;
    audioLabel = stepAudio;
  }

  const videoBitrate = getVideoBitrate(settings);

  return [
    ...inputs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    videoLabel,
    "-map",
    audioLabel,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    videoBitrate,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outputPath
  ];
}

export function buildIndexedAudioFilter(item: VideoItem, index: number): string {
  const duration = Math.max(0.1, effectiveDuration(item)).toFixed(3);
  const hasAudio = item.metadata?.hasAudio === true;

  if (hasAudio) {
    return `[${index}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${index}]`;
  }

  return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
}

function isTrimming(segments: TrimSegment[], duration: number): boolean {
  if (segments.length !== 1) {
    return segments.length > 0;
  }

  const [only] = segments;
  return Math.abs(only.start) > 1e-3 || Math.abs(only.end - duration) > 1e-3;
}

export function buildSegmentFilter(
  settings: OutputSettings,
  item: VideoItem,
  trimSegments: TrimSegment[],
  hasAudio: boolean,
  overlayInputIndex?: number
): string {
  const trimmed = isTrimming(trimSegments, item.metadata?.duration ?? 0);
  const parts: string[] = [];

  let videoRawLabel = "[0:v]";
  let audioRawLabel = hasAudio ? "[0:a]" : "[1:a:0]";

  if (trimmed) {
    if (trimSegments.length > 1) {
      parts.push(buildVideoTrimConcat("[0:v]", trimSegments));
    } else {
      const [only] = trimSegments;
      parts.push(`[0:v]trim=start=${formatTime(only.start)}:end=${formatTime(only.end)},setpts=PTS-STARTPTS[vcraw]`);
    }
    videoRawLabel = "[vcraw]";

    if (hasAudio) {
      if (trimSegments.length > 1) {
        parts.push(buildAudioTrimConcat("[0:a]", trimSegments));
      } else {
        const [only] = trimSegments;
        parts.push(`[0:a]atrim=start=${formatTime(only.start)}:end=${formatTime(only.end)},asetpts=PTS-STARTPTS[acraw]`);
      }
      audioRawLabel = "[acraw]";
    }
  }

  const videoOutLabel = overlayInputIndex !== undefined ? "[vfx]" : "[v]";
  parts.push(buildLabeledVideoFilter(settings, videoRawLabel, "[vbase]", item.rotation));
  parts.push(buildVideoEffectsChain(item, "[vbase]", videoOutLabel));
  if (overlayInputIndex !== undefined) {
    parts.push(`[vfx][${overlayInputIndex}:v]overlay=0:0:format=auto[v]`);
  }
  parts.push(buildAudioEffectsChain(item, audioRawLabel, "[ac]", settings, !hasAudio));

  return parts.join(";");
}

function buildVideoEffectsChain(item: VideoItem, inputLabel: string, outputLabel: string): string {
  const filters: string[] = [];

  if (item.reversed) {
    filters.push("reverse");
  }

  if (hasColorAdjustment(item)) {
    const { brightness, contrast, saturation } = item.colorAdjust;
    filters.push(`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`);
  }

  if (item.speed !== 1 && item.speed > 0) {
    filters.push(`setpts=PTS/${item.speed.toFixed(3)}`);
  }

  const speed = item.speed > 0 ? item.speed : 1;
  const outputDuration = effectiveDuration(item) / speed;
  const fadeIn = Math.min(Math.max(0, item.fadeIn), outputDuration / 2);
  if (fadeIn >= MIN_FADE_SECONDS) {
    filters.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  }
  const fadeOut = Math.min(Math.max(0, item.fadeOut), outputDuration / 2);
  if (fadeOut >= MIN_FADE_SECONDS) {
    const start = Math.max(0, outputDuration - fadeOut);
    filters.push(`fade=t=out:st=${start.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  }

  const freeze = Math.max(0, item.freezeFrame ?? 0);
  if (freeze >= MIN_FADE_SECONDS) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${freeze.toFixed(3)}`);
  }

  if (filters.length === 0) {
    filters.push("copy");
  }

  return `${inputLabel}${filters.join(",")}${outputLabel}`;
}

function buildAudioEffectsChain(
  item: VideoItem,
  inputLabel: string,
  outputLabel: string,
  settings?: OutputSettings,
  silentSource = false
): string {
  const filters: string[] = [];

  if (item.reversed && !silentSource) {
    filters.push("areverse");
  }

  const masterVolume = settings && Number.isFinite(settings.masterVolume) ? Math.min(2, Math.max(0, settings.masterVolume)) : 1;
  const volume = item.muted ? 0 : Math.max(0, item.volume) * masterVolume;
  filters.push(`volume=${volume.toFixed(3)}`);

  // The generated silence for audio-less clips is already at final output length, so tempo shifting would desync it.
  if (item.speed !== 1 && item.speed > 0 && !silentSource) {
    const speed = Math.min(2, Math.max(0.5, item.speed));
    filters.push(`atempo=${speed.toFixed(3)}`);
  }

  const speed = item.speed > 0 ? item.speed : 1;
  const outputDuration = effectiveDuration(item) / speed;
  const fadeIn = Math.min(Math.max(0, item.fadeIn), outputDuration / 2);
  if (fadeIn >= MIN_FADE_SECONDS) {
    filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  }
  const fadeOut = Math.min(Math.max(0, item.fadeOut), outputDuration / 2);
  if (fadeOut >= MIN_FADE_SECONDS) {
    const start = Math.max(0, outputDuration - fadeOut);
    filters.push(`afade=t=out:st=${start.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  }

  const freeze = Math.max(0, item.freezeFrame ?? 0);
  if (freeze >= MIN_FADE_SECONDS && !silentSource) {
    filters.push(`apad=pad_dur=${freeze.toFixed(3)}`);
  }

  return `${inputLabel}${filters.join(",")}${outputLabel}`;
}

/** Where to place a rendered text-overlay line vertically, as a ratio of output height. */
export function textOverlayYRatio(position: TextOverlayPosition): number {
  switch (position) {
    case "top":
      return 0.08;
    case "center":
      return 0.5;
    case "bottom":
    default:
      return 0.85;
  }
}

function hasColorAdjustment(item: VideoItem): boolean {
  const { brightness, contrast, saturation } = item.colorAdjust;
  return brightness !== 0 || contrast !== 1 || saturation !== 1;
}

function buildVideoTrimConcat(inputLabel: string, segments: TrimSegment[]): string {
  const splitLabels = segments.map((_, index) => `[v${index}src]`).join("");
  const partFilters = segments
    .map(
      (segment, index) =>
        `[v${index}src]trim=start=${formatTime(segment.start)}:end=${formatTime(segment.end)},setpts=PTS-STARTPTS[v${index}]`
    )
    .join(";");
  const concatInputs = segments.map((_, index) => `[v${index}]`).join("");
  const concatFilter = `${concatInputs}concat=n=${segments.length}:v=1:a=0[vcraw]`;

  return `${inputLabel}split=${segments.length}${splitLabels};${partFilters};${concatFilter}`;
}

function buildAudioTrimConcat(inputLabel: string, segments: TrimSegment[]): string {
  const splitLabels = segments.map((_, index) => `[a${index}src]`).join("");
  const partFilters = segments
    .map(
      (segment, index) =>
        `[a${index}src]atrim=start=${formatTime(segment.start)}:end=${formatTime(segment.end)},asetpts=PTS-STARTPTS[a${index}]`
    )
    .join(";");
  const concatInputs = segments.map((_, index) => `[a${index}]`).join("");
  const concatFilter = `${concatInputs}concat=n=${segments.length}:v=0:a=1[acraw]`;

  return `${inputLabel}asplit=${segments.length}${splitLabels};${partFilters};${concatFilter}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0";
  }
  return seconds.toFixed(3);
}
