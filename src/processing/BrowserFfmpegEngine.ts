import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import type {
  MergeExtras,
  MergeProgressCallback,
  OutputSettings,
  PreviewAsset,
  ProcessingEngine,
  VideoItem,
  VideoMetadata
} from "../shared/types";
import { effectiveDuration } from "../shared/trimSegments";
import { buildLabeledVideoFilter, buildVideoFilter } from "./ffmpegFilters";
import {
  createCrossfadeConcatArgs,
  createRemuxSegmentsArgs,
  createSegmentArgs,
  getVideoBitrate,
  segmentOutputDuration,
  type CrossfadeSegment
} from "./ffmpegSegments";
import { renderTextOverlayPng } from "../frontend/canvasUtils";
import { buildPostProcessArgs } from "./postProcess";

export { createRemuxSegmentsArgs, createSegmentArgs, getVideoBitrate };

type ProbeCapableFfmpeg = FFmpeg & {
  ffprobe: (args: string[]) => Promise<number>;
};

export class BrowserFfmpegEngine implements ProcessingEngine {
  private ffmpeg: ProbeCapableFfmpeg | null = null;
  private loadPromise: Promise<ProbeCapableFfmpeg> | null = null;
  private recentLogs: string[] = [];
  private activeProgress?: {
    itemIndex: number;
    itemCount: number;
    onProgress: MergeProgressCallback;
  };

  async probe(file: File): Promise<VideoMetadata> {
    const ffmpeg = await this.ensureLoaded();
    const inputName = `probe-${Date.now()}-${sanitizeFileName(file.name)}`;
    const outputName = `${inputName}.json`;

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    try {
      await ffmpeg.ffprobe([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        inputName,
        "-o",
        outputName
      ]);

      const rawOutput = await ffmpeg.readFile(outputName);
      const info = JSON.parse(decodeFfmpegFile(rawOutput)) as FfprobeResult;
      const videoStream = info.streams.find((stream) => stream.codec_type === "video");
      const audioStream = info.streams.some((stream) => stream.codec_type === "audio");
      const width = videoStream?.width ?? 0;
      const height = videoStream?.height ?? 0;
      const duration = Number(videoStream?.duration ?? info.format.duration ?? 0);

      return {
        duration,
        width,
        height,
        aspectRatio: width > 0 && height > 0 ? width / height : 0,
        hasAudio: audioStream
      };
    } finally {
      await safeDelete(ffmpeg, inputName);
      await safeDelete(ffmpeg, outputName);
    }
  }

  async createPreview(file: File): Promise<PreviewAsset> {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const sourceUrl = URL.createObjectURL(file);
      let settled = false;

      const cleanup = () => {
        URL.revokeObjectURL(sourceUrl);
        video.removeAttribute("src");
        video.load();
      };

      const settle = (asset: PreviewAsset) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(asset);
        }
      };

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };

      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = sourceUrl;

      video.addEventListener("loadedmetadata", () => {
        video.currentTime = Math.min(0.8, Math.max(0, video.duration * 0.08));
      });

      video.addEventListener("seeked", () => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(320, video.videoWidth);
        canvas.height = Math.max(180, video.videoHeight);
        const context = canvas.getContext("2d");

        if (!context) {
          fail(new Error("Could not create preview canvas."));
          return;
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              fail(new Error("Could not render video preview."));
              return;
            }

            settle({ thumbnailUrl: URL.createObjectURL(blob) });
          },
          "image/jpeg",
          0.82
        );
      });

      video.addEventListener("error", () => fail(new Error("Could not read video preview.")));
    });
  }

  async merge(
    items: VideoItem[],
    settings: OutputSettings,
    onProgress: MergeProgressCallback,
    extras?: MergeExtras
  ): Promise<Blob> {
    if (items.length === 0) {
      throw new Error("Add at least one MP4 before generating.");
    }

    const ffmpeg = await this.ensureLoaded();
    const jobId = Date.now();
    const inputNames: string[] = [];
    const segmentNames: string[] = [];
    const needsPost = Boolean(extras?.watermark || extras?.backgroundMusic);
    const remuxName = `remuxed-${jobId}.mp4`;
    const outputName = needsPost ? `merged-${jobId}.mp4` : remuxName;
    const watermarkName = `watermark-${jobId}`;
    const musicName = `music-${jobId}`;

    onProgress({
      phase: "normalizing",
      completed: 0,
      total: items.length,
      ratio: 0,
      message: "Preparing clips"
    });

    try {
      for (const [index, item] of items.entries()) {
        const inputName = `input-${jobId}-${index}-${sanitizeFileName(item.file.name)}`;
        const segmentName = `segment-${jobId}-${index}.ts`;
        inputNames.push(inputName);
        segmentNames.push(segmentName);

        await ffmpeg.writeFile(inputName, await fetchFile(item.file));

        let overlayName: string | undefined;
        if (item.textOverlay && item.textOverlay.text.trim().length > 0) {
          overlayName = `overlay-${jobId}-${index}.png`;
          const overlayBlob = await renderTextOverlayPng(item.textOverlay, settings.width, settings.height);
          await ffmpeg.writeFile(overlayName, await fetchFile(overlayBlob));
          inputNames.push(overlayName);
        }

        this.activeProgress = { itemIndex: index, itemCount: items.length + 1, onProgress };

        onProgress({
          phase: "normalizing",
          completed: index,
          total: items.length,
          ratio: index / (items.length + 1),
          message: `Encoding ${item.name}`
        });

        await this.execWithContext(
          ffmpeg,
          createSegmentArgs(inputName, segmentName, item, settings, { textOverlayPath: overlayName }),
          `Could not encode ${item.name}.`
        );
        await safeDelete(ffmpeg, inputName);
        if (overlayName) {
          await safeDelete(ffmpeg, overlayName);
        }

        onProgress({
          phase: "normalizing",
          completed: index + 1,
          total: items.length,
          ratio: (index + 1) / (items.length + 1),
          message: `${item.name} ready`
        });
      }

      onProgress({
        phase: "concatenating",
        completed: items.length,
        total: items.length,
        ratio: items.length / (items.length + 1),
        message: "Writing final MP4"
      });

      this.activeProgress = { itemIndex: items.length, itemCount: items.length + 1, onProgress };
      const hasCrossfades =
        items.length > 1 && items.slice(0, -1).some((item) => (item.crossfadeAfter ?? 0) > 0.01);
      if (hasCrossfades) {
        const crossfadeSegments: CrossfadeSegment[] = items.map((item, index) => ({
          path: segmentNames[index],
          duration: segmentOutputDuration(item),
          crossfadeAfter: item.crossfadeAfter ?? 0
        }));
        await this.execWithContext(
          ffmpeg,
          createCrossfadeConcatArgs(crossfadeSegments, remuxName, settings),
          "Could not write the merged MP4 with crossfades."
        );
      } else {
        await this.execWithContext(ffmpeg, createRemuxSegmentsArgs(segmentNames, remuxName), "Could not write the merged MP4.");
      }

      if (needsPost) {
        onProgress({
          phase: "concatenating",
          completed: items.length,
          total: items.length,
          ratio: 1,
          message: "Applying watermark / music"
        });

        if (extras?.watermark) {
          await ffmpeg.writeFile(watermarkName, await fetchFile(extras.watermark.file));
        }
        if (extras?.backgroundMusic) {
          await ffmpeg.writeFile(musicName, await fetchFile(extras.backgroundMusic.file));
        }

        const totalDurationSeconds = items.reduce((sum, item) => sum + Math.max(0.1, effectiveDuration(item)) / item.speed, 0);

        await this.execWithContext(
          ffmpeg,
          buildPostProcessArgs(remuxName, outputName, {
            watermark: extras?.watermark
              ? {
                  inputPath: watermarkName,
                  opacity: extras.watermark.opacity,
                  position: extras.watermark.position,
                  scale: extras.watermark.scale
                }
              : undefined,
            backgroundMusic: extras?.backgroundMusic
              ? { inputPath: musicName, volume: extras.backgroundMusic.volume }
              : undefined,
            outputWidth: settings.width,
            totalDurationSeconds
          }),
          "Could not apply watermark or background music."
        );
      }

      this.activeProgress = undefined;

      const output = await ffmpeg.readFile(outputName);

      onProgress({
        phase: "complete",
        completed: items.length,
        total: items.length,
        ratio: 1,
        message: "Merge complete"
      });

      return new Blob([toBlobPart(output)], { type: "video/mp4" });
    } finally {
      this.activeProgress = undefined;
      await Promise.all([
        ...inputNames.map((name) => safeDelete(ffmpeg, name)),
        ...segmentNames.map((name) => safeDelete(ffmpeg, name)),
        safeDelete(ffmpeg, remuxName),
        safeDelete(ffmpeg, outputName),
        safeDelete(ffmpeg, watermarkName),
        safeDelete(ffmpeg, musicName)
      ]);
    }
  }

  async convertToGif(source: Blob, fps = 10, width = 480): Promise<Blob> {
    const ffmpeg = await this.ensureLoaded();
    const jobId = Date.now();
    const inputName = `gif-src-${jobId}.mp4`;
    const paletteName = `gif-palette-${jobId}.png`;
    const outputName = `gif-out-${jobId}.gif`;

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(source));

      const filter = `fps=${fps},scale=${width}:-1:flags=lanczos`;
      await this.execWithContext(
        ffmpeg,
        ["-i", inputName, "-vf", `${filter},split[a][b];[a]palettegen[p];[b][p]paletteuse`, outputName],
        "Could not generate GIF."
      );

      const output = await ffmpeg.readFile(outputName);
      return new Blob([toBlobPart(output)], { type: "image/gif" });
    } finally {
      await Promise.all([safeDelete(ffmpeg, inputName), safeDelete(ffmpeg, paletteName), safeDelete(ffmpeg, outputName)]);
    }
  }

  cancel(): void {
    this.ffmpeg?.terminate();
    this.ffmpeg = null;
    this.loadPromise = null;
    this.activeProgress = undefined;
  }

  private async ensureLoaded(): Promise<ProbeCapableFfmpeg> {
    if (this.ffmpeg) {
      return this.ffmpeg;
    }

    if (!this.loadPromise) {
      const ffmpeg = new FFmpeg() as ProbeCapableFfmpeg;
      ffmpeg.on("log", ({ message }) => {
        this.recentLogs = [...this.recentLogs.slice(-24), message];
      });
      ffmpeg.on("progress", ({ progress }) => {
        if (!this.activeProgress) {
          return;
        }

        const { itemIndex, itemCount, onProgress } = this.activeProgress;
        const normalizedProgress = (itemIndex + Math.max(0, Math.min(1, progress))) / itemCount;

        onProgress({
          phase: "concatenating",
          completed: itemIndex,
          total: itemCount,
          ratio: normalizedProgress,
          message: itemIndex >= itemCount - 1 ? "Writing final MP4" : "Encoding clip"
        });
      });

      this.loadPromise = ffmpeg
        .load({ coreURL, wasmURL })
        .then(() => {
          this.ffmpeg = ffmpeg;
          return ffmpeg;
        });
    }

    return this.loadPromise;
  }

  private async execWithContext(ffmpeg: ProbeCapableFfmpeg, args: string[], fallbackMessage: string): Promise<void> {
    this.recentLogs = [];

    try {
      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) {
        throw new Error(`FFmpeg exited with code ${exitCode}.`);
      }
    } catch (error) {
      const detail = this.recentLogs
        .filter((line) => line.trim().length > 0)
        .slice(-6)
        .join(" ");
      const message = detail ? `${fallbackMessage} FFmpeg: ${detail}` : fallbackMessage;

      throw new Error(error instanceof Error && error.message ? `${message} (${error.message})` : message);
    }
  }
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

export function createNormalizeArgs(inputName: string, outputName: string, item: VideoItem, settings: OutputSettings): string[] {
  const duration = Math.max(0.1, item.metadata?.duration ?? 0.1).toFixed(3);
  const baseArgs = ["-i", inputName];
  const hasAudio = item.metadata?.hasAudio === true;
  const filter = buildVideoFilter(settings, item.rotation);
  const videoArgs = [
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p"
  ];
  const audioArgs = hasAudio
    ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2"]
    : ["-f", "lavfi", "-t", duration, "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"];

  return [...baseArgs, ...audioArgs.slice(0, hasAudio ? 0 : 6), ...videoArgs, ...audioArgs.slice(hasAudio ? 0 : 6), "-shortest", outputName];
}

export function createConcatArgs(concatFile: string, outputName: string): string[] {
  return [
    "-fflags",
    "+genpts",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
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
    outputName
  ];
}

export function createSinglePassMergeArgs(
  inputNames: string[],
  outputName: string,
  items: VideoItem[],
  settings: OutputSettings
): string[] {
  const inputArgs = inputNames.flatMap((inputName) => ["-i", inputName]);
  const filterParts = items.flatMap((item, index) => [
    buildLabeledVideoFilter(settings, `[${index}:v]`, `[v${index}]`, item.rotation),
    buildAudioFilter(item, index)
  ]);
  const concatInputs = items.map((_, index) => `[v${index}][a${index}]`).join("");
  const filterGraph = [...filterParts, `${concatInputs}concat=n=${items.length}:v=1:a=1[vout][aout]`].join(";");

  return [
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
    "-max_muxing_queue_size",
    "4096",
    "-movflags",
    "+faststart",
    outputName
  ];
}

function buildAudioFilter(item: VideoItem, index: number): string {
  const duration = Math.max(0.1, item.metadata?.duration ?? 0.1).toFixed(3);

  if (item.metadata?.hasAudio) {
    return `[${index}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${index}]`;
  }

  return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
}

function decodeFfmpegFile(fileData: string | Uint8Array): string {
  if (typeof fileData === "string") {
    return fileData;
  }

  return new TextDecoder().decode(fileData);
}

function toBlobPart(fileData: string | Uint8Array): BlobPart {
  if (typeof fileData === "string") {
    return fileData;
  }

  const bytes = new Uint8Array(fileData);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function safeDelete(ffmpeg: FFmpeg, fileName: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(fileName);
  } catch {
    // File cleanup should not mask the merge/probe result.
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-z0-9._-]/gi, "_");
}
