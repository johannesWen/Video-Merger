import type { OutputSettings, VideoItem } from "../shared/types";
import { buildLabeledVideoFilter } from "./ffmpegFilters";

export function createSegmentArgs(inputPath: string, outputPath: string, item: VideoItem, settings: OutputSettings): string[] {
  const duration = Math.max(0.1, item.metadata?.duration ?? 0.1).toFixed(3);
  const hasAudio = item.metadata?.hasAudio === true;
  const videoBitrate = getVideoBitrate(settings);
  const silentAudioInput = ["-f", "lavfi", "-t", duration, "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
  const audioMap = hasAudio ? ["-map", "0:a:0"] : ["-map", "1:a:0"];

  return [
    "-i",
    inputPath,
    ...(hasAudio ? [] : silentAudioInput),
    "-filter_complex",
    buildLabeledVideoFilter(settings, "[0:v]", "[v]", item.rotation),
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
  const duration = Math.max(0.1, item.metadata?.duration ?? 0.1).toFixed(3);
  const hasAudio = item.metadata?.hasAudio === true;

  if (hasAudio) {
    return `[${index}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${index}]`;
  }

  return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
}
