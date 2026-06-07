import type { AspectHandling, OutputSettings } from "../shared/types";

export function buildVideoFilter(settings: OutputSettings): string {
  return buildLabeledVideoFilter(settings, "[0:v]", "[v]");
}

export function buildLabeledVideoFilter(settings: OutputSettings, inputLabel: string, outputLabel: string): string {
  const { width, height, aspectHandling } = settings;
  const labelBase = outputLabel.replace(/[[\]]/g, "") || "video";
  const baseLabel = `[${labelBase}base]`;
  const foregroundSourceLabel = `[${labelBase}fgsrc]`;
  const backgroundLabel = `[${labelBase}bg]`;
  const foregroundLabel = `[${labelBase}fg]`;

  const filters: Record<AspectHandling, string> = {
    "fit-blur": [
      `${inputLabel}split=2${baseLabel}${foregroundSourceLabel}`,
      `${baseLabel}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2${backgroundLabel}`,
      `${foregroundSourceLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease${foregroundLabel}`,
      `${backgroundLabel}${foregroundLabel}overlay=(W-w)/2:(H-h)/2,fps=30,setpts=PTS-STARTPTS,setsar=1,format=yuv420p${outputLabel}`
    ].join(";"),
    "center-crop": [
      `${inputLabel}scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      "fps=30",
      "setpts=PTS-STARTPTS",
      "setsar=1",
      `format=yuv420p${outputLabel}`
    ].join(","),
    letterbox: [
      `${inputLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "fps=30",
      "setpts=PTS-STARTPTS",
      "setsar=1",
      `format=yuv420p${outputLabel}`
    ].join(",")
  };

  return filters[aspectHandling];
}
