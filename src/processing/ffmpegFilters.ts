import type { AspectHandling, ClipRotation, OutputSettings } from "../shared/types";

export function buildVideoFilter(settings: OutputSettings, rotation: ClipRotation = 0): string {
  return buildLabeledVideoFilter(settings, "[0:v]", "[v]", rotation);
}

export function buildLabeledVideoFilter(
  settings: OutputSettings,
  inputLabel: string,
  outputLabel: string,
  rotation: ClipRotation = 0
): string {
  const { width, height, aspectHandling } = settings;
  const fps = Number.isFinite(settings.fps) && settings.fps > 0 ? settings.fps : 30;
  const labelBase = outputLabel.replace(/[[\]]/g, "") || "video";
  const baseLabel = `[${labelBase}base]`;
  const foregroundSourceLabel = `[${labelBase}fgsrc]`;
  const backgroundLabel = `[${labelBase}bg]`;
  const foregroundLabel = `[${labelBase}fg]`;
  const rotationPrefix = buildRotationPrefix(inputLabel, rotation);

  const filters: Record<AspectHandling, string> = {
    "fit-blur": [
      `${rotationPrefix}split=2${baseLabel}${foregroundSourceLabel}`,
      `${baseLabel}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2${backgroundLabel}`,
      `${foregroundSourceLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease${foregroundLabel}`,
      `${backgroundLabel}${foregroundLabel}overlay=(W-w)/2:(H-h)/2,fps=${fps},setpts=PTS-STARTPTS,setsar=1,format=yuv420p${outputLabel}`
    ].join(";"),
    "center-crop": [
      `${rotationPrefix}scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      `fps=${fps}`,
      "setpts=PTS-STARTPTS",
      "setsar=1",
      `format=yuv420p${outputLabel}`
    ].join(","),
    letterbox: [
      `${rotationPrefix}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      `fps=${fps}`,
      "setpts=PTS-STARTPTS",
      "setsar=1",
      `format=yuv420p${outputLabel}`
    ].join(",")
  };

  return filters[aspectHandling];
}

function buildRotationPrefix(inputLabel: string, rotation: ClipRotation): string {
  switch (rotation) {
    case 0:
      return inputLabel;
    case 1:
      return `${inputLabel}transpose=1,`;
    case 2:
      return `${inputLabel}transpose=1,transpose=1,`;
    case 3:
      return `${inputLabel}transpose=2,`;
    default:
      return inputLabel;
  }
}
