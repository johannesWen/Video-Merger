import type { ClipRotation, OutputSettings, VideoMetadata } from "../shared/types";
import { buildLabeledVideoFilter } from "../processing/ffmpegFilters";

export interface BackendClip {
  inputPath: string;
  metadata: VideoMetadata;
  rotation: ClipRotation;
}

export function buildBackendMergeArgs(clips: BackendClip[], outputPath: string, settings: OutputSettings): string[] {
  const inputArgs = clips.flatMap((clip) => ["-i", clip.inputPath]);
  const filterParts = clips.flatMap((clip, index) => [
    buildLabeledVideoFilter(settings, `[${index}:v]`, `[v${index}]`, clip.rotation),
    buildBackendAudioFilter(clip, index)
  ]);
  const concatInputs = clips.map((_, index) => `[v${index}][a${index}]`).join("");
  const filterGraph = [...filterParts, `${concatInputs}concat=n=${clips.length}:v=1:a=1[vout][aout]`].join(";");

  return [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterGraph,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
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

export function buildProbeArgs(inputPath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

export function parseProbeOutput(rawOutput: string): VideoMetadata {
  const info = JSON.parse(rawOutput) as FfprobeResult;
  const videoStream = info.streams.find((stream) => stream.codec_type === "video");
  const hasAudio = info.streams.some((stream) => stream.codec_type === "audio");
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;
  const duration = Number(videoStream?.duration ?? info.format.duration ?? 0);

  return {
    duration,
    width,
    height,
    aspectRatio: width > 0 && height > 0 ? width / height : 0,
    hasAudio
  };
}

function buildBackendAudioFilter(clip: BackendClip, index: number): string {
  const duration = Math.max(0.1, clip.metadata.duration).toFixed(3);

  if (clip.metadata.hasAudio) {
    return `[${index}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${index}]`;
  }

  return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
}

interface FfprobeResult {
  streams: Array<{
    codec_type: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format: {
    duration?: string;
  };
}
