import type { OutputSettings, TrimSegment, VideoItem } from "../shared/types";
import { effectiveDuration, normalizeSegments } from "../shared/trimSegments";
import { buildLabeledVideoFilter } from "./ffmpegFilters";

export function createSegmentArgs(inputPath: string, outputPath: string, item: VideoItem, settings: OutputSettings): string[] {
  const rawDuration = item.metadata?.duration ?? 0.1;
  const duration = Math.max(0.1, rawDuration).toFixed(3);
  const hasAudio = item.metadata?.hasAudio === true;
  const videoBitrate = getVideoBitrate(settings);
  const trimSegments = normalizeSegments(item.trimSegments, rawDuration);
  const trimmed = isTrimming(trimSegments, rawDuration);
  const keptDuration = effectiveDuration({ metadata: item.metadata, trimSegments: trimSegments });
  const silentDuration = Math.max(0.1, keptDuration).toFixed(3);
  const silentAudioInput = ["-f", "lavfi", "-t", silentDuration, "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
  const audioMap = hasAudio
    ? trimmed
      ? ["-map", "[ac]"]
      : ["-map", "0:a:0"]
    : ["-map", "1:a:0"];

  return [
    "-i",
    inputPath,
    ...(hasAudio ? [] : silentAudioInput),
    "-filter_complex",
    buildSegmentFilter(settings, item, trimSegments, hasAudio),
    "-map",
    "[v]",
    ...audioMap,
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

export function getVideoBitrate(settings: OutputSettings): string {
  const pixels = settings.width * settings.height;

  if (pixels >= 1920 * 1080) {
    return "4500k";
  }

  if (pixels >= 1280 * 720) {
    return "2800k";
  }

  return "1800k";
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

function buildSegmentFilter(
  settings: OutputSettings,
  item: VideoItem,
  trimSegments: TrimSegment[],
  hasAudio: boolean
): string {
  if (!isTrimming(trimSegments, item.metadata?.duration ?? 0)) {
    return buildLabeledVideoFilter(settings, "[0:v]", "[v]", item.rotation);
  }

  const videoInputLabel = "[0:v]";
  const audioInputLabel = "[0:a]";
  const parts: string[] = [];

  if (trimSegments.length > 1) {
    parts.push(buildVideoTrimConcat(videoInputLabel, trimSegments));
  } else {
    const [only] = trimSegments;
    parts.push(`${videoInputLabel}trim=start=${formatTime(only.start)}:end=${formatTime(only.end)},setpts=PTS-STARTPTS[vcraw]`);
  }

  if (hasAudio) {
    if (trimSegments.length > 1) {
      parts.push(buildAudioTrimConcat(audioInputLabel, trimSegments));
    } else {
      const [only] = trimSegments;
      parts.push(`${audioInputLabel}atrim=start=${formatTime(only.start)}:end=${formatTime(only.end)},asetpts=PTS-STARTPTS[ac]`);
    }
  }

  parts.push(buildLabeledVideoFilter(settings, "[vcraw]", "[v]", item.rotation));

  return parts.join(";");
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
  const concatFilter = `${concatInputs}concat=n=${segments.length}:v=0:a=1[ac]`;

  return `${inputLabel}asplit=${segments.length}${splitLabels};${partFilters};${concatFilter}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0";
  }
  return seconds.toFixed(3);
}
