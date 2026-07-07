export interface PostProcessOptions {
  watermark?: {
    inputPath: string;
    opacity: number;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
    scale: number;
  };
  backgroundMusic?: {
    inputPath: string;
    volume: number;
  };
  outputWidth: number;
  totalDurationSeconds: number;
}

export function needsPostProcess(options: PostProcessOptions): boolean {
  return Boolean(options.watermark || options.backgroundMusic);
}

export function buildPostProcessArgs(mergedPath: string, outputPath: string, options: PostProcessOptions): string[] {
  const inputs: string[] = ["-i", mergedPath];
  const filterParts: string[] = [];
  let videoLabel = "[0:v]";
  let audioLabel = "[0:a]";
  let nextInputIndex = 1;

  if (options.watermark) {
    const watermarkIndex = nextInputIndex;
    nextInputIndex += 1;
    inputs.push("-loop", "1", "-i", options.watermark.inputPath);

    const watermarkWidth = Math.max(16, Math.round(options.outputWidth * options.watermark.scale));
    const margin = 24;
    const position = watermarkPositionExpression(options.watermark.position, margin);

    filterParts.push(`[${watermarkIndex}:v]scale=${watermarkWidth}:-1,format=rgba,colorchannelmixer=aa=${options.watermark.opacity.toFixed(3)}[wm]`);
    filterParts.push(`${videoLabel}[wm]overlay=${position}:shortest=1[vwm]`);
    videoLabel = "[vwm]";
  }

  if (options.backgroundMusic) {
    const musicIndex = nextInputIndex;
    nextInputIndex += 1;
    inputs.push("-stream_loop", "-1", "-i", options.backgroundMusic.inputPath);

    filterParts.push(`[${musicIndex}:a]volume=${options.backgroundMusic.volume.toFixed(3)}[music]`);
    filterParts.push(`${audioLabel}[music]amix=inputs=2:duration=first:dropout_transition=2[amixed]`);
    audioLabel = "[amixed]";
  }

  const args = [...inputs];
  if (filterParts.length > 0) {
    args.push("-filter_complex", filterParts.join(";"), "-map", videoLabel, "-map", audioLabel);
  } else {
    args.push("-map", "0:v", "-map", "0:a");
  }

  args.push(
    "-t",
    options.totalDurationSeconds.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    outputPath
  );

  return args;
}

type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

function watermarkPositionExpression(position: WatermarkPosition, margin: number): string {
  switch (position) {
    case "top-left":
      return `${margin}:${margin}`;
    case "top-right":
      return `W-w-${margin}:${margin}`;
    case "bottom-left":
      return `${margin}:H-h-${margin}`;
    case "center":
      return "(W-w)/2:(H-h)/2";
    case "bottom-right":
    default:
      return `W-w-${margin}:H-h-${margin}`;
  }
}
