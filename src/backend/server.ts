import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import express from "express";
import multer from "multer";
import type { ClipRotation, OutputSettings } from "../shared/types";
import {
  createRemuxSegmentsArgs,
  createSegmentArgs,
  formatFfmpegTime,
  parseFfmpegProgressLine,
  parseProbeOutput,
  progressRatio,
  type BackendClip
} from "./ffmpegCommands";

const port = Number(process.env.PORT ?? 5174);
const upload = multer({
  dest: path.join(tmpdir(), "video-merger-uploads"),
  limits: {
    files: 50,
    fileSize: 4 * 1024 * 1024 * 1024
  }
});

const app = express();

type JobStatus = "starting" | "encoding" | "muxing" | "complete" | "error" | "cancelled";
type JobPhase = "encoding" | "muxing";

interface JobProgress {
  ratio: number;
  phase: JobPhase;
  currentClipIndex: number;
  clipCount: number;
  currentTimeUs: number;
  clipDurationUs: number;
  message: string;
}

interface MergeJob {
  id: string;
  status: JobStatus;
  settings: OutputSettings;
  clips: BackendClip[];
  workDir: string;
  uploadedFiles: Express.Multer.File[];
  outputPath: string;
  segmentPaths: string[];
  totalDuration: number;
  currentClipIndex: number;
  currentTimeUs: number;
  phase: JobPhase;
  ffmpegChild: ChildProcess | null;
  listeners: Set<JobListener>;
  errorMessage?: string;
  completedAt?: number;
}

type JobListener = (event: JobEvent) => void;

type JobEvent =
  | { type: "status"; status: JobStatus }
  | { type: "progress"; progress: JobProgress }
  | { type: "complete" }
  | { type: "error"; error: string };

const jobs = new Map<string, MergeJob>();
const JOB_TTL_MS = 5 * 60 * 1000;

app.get("/api/health", async (_request, response) => {
  const ffmpeg = await commandExists("ffmpeg");
  const ffprobe = await commandExists("ffprobe");

  response.json({
    ok: ffmpeg && ffprobe,
    ffmpeg,
    ffprobe,
    mode: "backend"
  });
});

app.post("/api/merge", upload.array("videos"), async (request, response) => {
  const files = (request.files ?? []) as Express.Multer.File[];

  if (files.length === 0) {
    response.status(400).json({ error: "Upload at least one MP4 file." });
    return;
  }

  let settings: OutputSettings;
  let rotations: ClipRotation[];
  try {
    settings = parseSettings(request.body.settings);
    rotations = parseRotations(request.body.rotations, files.length);
  } catch (parseError) {
    await cleanupFiles(files);
    response.status(400).json({ error: getErrorMessage(parseError) });
    return;
  }

  const jobId = randomUUID();
  const workDir = await mkdtemp(path.join(tmpdir(), "video-merger-"));
  const outputPath = path.join(workDir, "merged-video.mp4");

  const clips: BackendClip[] = [];
  for (const [index, file] of files.entries()) {
    try {
      const metadata = await probeFile(file.path);
      clips.push({ inputPath: file.path, metadata, rotation: rotations[index] });
    } catch (probeError) {
      await cleanup(files, workDir);
      response.status(500).json({ error: getErrorMessage(probeError) });
      return;
    }
  }

  const totalDuration = clips.reduce((sum, clip) => sum + Math.max(0.1, clip.metadata.duration), 0);
  const segmentPaths = clips.map((_, index) => path.join(workDir, `segment-${index}.ts`));

  const job: MergeJob = {
    id: jobId,
    status: "starting",
    settings,
    clips,
    workDir,
    uploadedFiles: files,
    outputPath,
    segmentPaths,
    totalDuration,
    currentClipIndex: 0,
    currentTimeUs: 0,
    phase: "encoding",
    ffmpegChild: null,
    listeners: new Set()
  };
  jobs.set(jobId, job);

  void runMergeJob(job).catch((error) => {
    job.status = "error";
    job.errorMessage = getErrorMessage(error);
    emitJobEvent(job, { type: "error", error: job.errorMessage });
  });

  response.json({ jobId });
});

app.get("/api/merge/:id/events", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Merge job not found." });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const listener: JobListener = (event) => {
    if (event.type === "status") {
      send("status", { status: event.status });
    } else if (event.type === "progress") {
      send("progress", event.progress);
    } else if (event.type === "complete") {
      send("complete", {});
      response.end();
    } else if (event.type === "error") {
      send("error", { error: event.error });
      response.end();
    }
  };

  job.listeners.add(listener);

  send("status", { status: job.status });
  if (job.status === "encoding" || job.status === "muxing") {
    send("progress", buildProgressSnapshot(job));
  } else if (job.status === "complete") {
    send("complete", {});
    response.end();
    return;
  } else if (job.status === "error" || job.status === "cancelled") {
    send("error", { error: job.errorMessage ?? "Merge failed." });
    response.end();
    return;
  }

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15000);

  const close = () => {
    clearInterval(heartbeat);
    job.listeners.delete(listener);
  };

  request.on("close", close);
  response.on("close", close);
});

app.get("/api/merge/:id/result", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Merge job not found." });
    return;
  }
  if (job.status !== "complete") {
    response.status(409).json({ error: `Merge is not complete (status: ${job.status}).` });
    return;
  }

  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Content-Disposition", 'attachment; filename="merged-video.mp4"');
  const stream = createReadStream(job.outputPath);
  stream.pipe(response);
  stream.on("close", () => {
    job.completedAt = Date.now();
  });
  stream.on("error", (error) => {
    response.destroy(error);
  });
});

app.delete("/api/merge/:id", async (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Merge job not found." });
    return;
  }

  job.status = "cancelled";
  job.ffmpegChild?.kill("SIGTERM");
  emitJobEvent(job, { type: "error", error: "Merge cancelled." });
  jobs.delete(job.id);
  await cleanup(job.uploadedFiles, job.workDir);
  response.json({ ok: true });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "complete" && job.completedAt && now - job.completedAt > JOB_TTL_MS) {
      jobs.delete(id);
      void cleanup(job.uploadedFiles, job.workDir);
    }
  }
}, 60_000).unref();

app.listen(port, () => {
  console.log(`Backend FFmpeg API listening on http://localhost:${port}`);
});

async function probeFile(filePath: string) {
  const output = await runCommand("ffprobe", buildProbeArgs(filePath));
  return parseProbeOutput(output.stdout);
}

interface RunFfmpegOptions {
  onChild: (child: ChildProcess) => void;
  onProgress: (currentTimeUs: number) => void;
}

function runFfmpegWithProgress(args: string[], options: RunFfmpegOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [...args, "-progress", "pipe:1", "-nostats"]);
    options.onChild(child);
    let stderr = "";
    let settled = false;
    let lastEmittedTimeUs = 0;
    let lastEmitAt = 0;

    const finalize = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      action();
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const update = parseFfmpegProgressLine(line);
      if (update.currentTimeUs !== undefined && update.currentTimeUs >= lastEmittedTimeUs) {
        lastEmittedTimeUs = update.currentTimeUs;
        const now = Date.now();
        if (now - lastEmitAt >= 250) {
          lastEmitAt = now;
          options.onProgress(update.currentTimeUs);
        }
      }
      if (update.done) {
        options.onProgress(lastEmittedTimeUs);
        finalize(() => {
          rl.close();
          resolve();
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finalize(() => reject(error));
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      if (exitCode === 0) {
        finalize(() => resolve());
        return;
      }
      const message = stderr.trim().length > 0
        ? stderr.trim().slice(-1200)
        : `ffmpeg exited with code ${exitCode}`;
      finalize(() => reject(new Error(message)));
    });
  });
}

async function runMergeJob(job: MergeJob): Promise<void> {
  job.status = "encoding";
  emitJobEvent(job, { type: "status", status: job.status });
  emitJobEvent(job, { type: "progress", progress: buildProgressSnapshot(job) });

  for (const [index, clip] of job.clips.entries()) {
    const segmentPath = job.segmentPaths[index];
    job.currentClipIndex = index;
    job.currentTimeUs = 0;
    job.phase = "encoding";
    emitJobEvent(job, { type: "progress", progress: buildProgressSnapshot(job) });

    const item = makeVideoItemForFilter(clip);
    const args = createSegmentArgs(clip.inputPath, segmentPath, item, job.settings);

    await runFfmpegWithProgress(args, {
      onChild: (child) => {
        job.ffmpegChild = child;
      },
      onProgress: (currentTimeUs) => {
        job.currentTimeUs = currentTimeUs;
        emitJobEvent(job, { type: "progress", progress: buildProgressSnapshot(job) });
      }
    });
    job.ffmpegChild = null;
  }

  job.phase = "muxing";
  job.currentTimeUs = 0;
  job.status = "muxing";
  emitJobEvent(job, { type: "status", status: job.status });
  emitJobEvent(job, { type: "progress", progress: buildProgressSnapshot(job) });

  await runFfmpegWithProgress(createRemuxSegmentsArgs(job.segmentPaths, job.outputPath), {
    onChild: (child) => {
      job.ffmpegChild = child;
    },
    onProgress: (currentTimeUs) => {
      job.currentTimeUs = currentTimeUs;
      emitJobEvent(job, { type: "progress", progress: buildProgressSnapshot(job) });
    }
  });
  job.ffmpegChild = null;

  job.status = "complete";
  job.completedAt = Date.now();
  emitJobEvent(job, { type: "status", status: job.status });
  emitJobEvent(job, { type: "complete" });
}

function buildProgressSnapshot(job: MergeJob): JobProgress {
  const clipCount = job.clips.length;
  const currentClip = job.clips[job.currentClipIndex];
  const clipDuration = Math.max(0.1, currentClip?.metadata.duration ?? job.totalDuration);
  const currentClipRatio = progressRatio(job.currentTimeUs, clipDuration);
  const totalRatio = job.phase === "encoding"
    ? (job.currentClipIndex + currentClipRatio) / Math.max(1, clipCount)
    : (clipCount + currentClipRatio) / Math.max(1, clipCount);
  const bounded = Math.max(0, Math.min(1, totalRatio));

  const message = job.phase === "encoding" && currentClip
    ? `Encoding clip ${job.currentClipIndex + 1}/${clipCount} (${formatFfmpegTime(job.currentTimeUs / 1_000_000)} / ${formatFfmpegTime(clipDuration)})`
    : "Muxing final MP4";

  return {
    ratio: bounded,
    phase: job.phase,
    currentClipIndex: job.currentClipIndex,
    clipCount,
    currentTimeUs: job.currentTimeUs,
    clipDurationUs: Math.round(clipDuration * 1_000_000),
    message
  };
}

function emitJobEvent(job: MergeJob, event: JobEvent): void {
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch {
      // Listener failures must not stop other subscribers from receiving events.
    }
  }
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const result = { stdout: stdout.join(""), stderr: stderr.join("") };
      if (exitCode === 0) {
        resolve(result);
        return;
      }
      reject(new Error(`${command} exited with code ${exitCode}. ${result.stderr.slice(-1400)}`.trim()));
    });
  });
}

function buildProbeArgs(inputPath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}

function makeVideoItemForFilter(clip: BackendClip) {
  return {
    id: clip.inputPath,
    file: { name: path.basename(clip.inputPath) } as File,
    objectUrl: "",
    name: path.basename(clip.inputPath),
    size: 0,
    mimeType: "video/mp4",
    createdAt: 0,
    status: "ready" as const,
    rotation: clip.rotation,
    metadata: clip.metadata
  };
}

function parseSettings(rawSettings: unknown): OutputSettings {
  if (typeof rawSettings !== "string") {
    throw new Error("Missing output settings.");
  }

  const settings = JSON.parse(rawSettings) as OutputSettings;
  if (!Number.isFinite(settings.width) || !Number.isFinite(settings.height) || settings.format !== "mp4") {
    throw new Error("Invalid output settings.");
  }

  return settings;
}

function parseRotations(rawRotations: unknown, length: number): ClipRotation[] {
  const fallback = (): ClipRotation[] => Array.from({ length }, () => 0 as ClipRotation);

  if (typeof rawRotations !== "string" || length === 0) {
    return fallback();
  }

  try {
    const parsed = JSON.parse(rawRotations) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== length) {
      return fallback();
    }

    return parsed.map((value) => normalizeRotation(value));
  } catch {
    return fallback();
  }
}

function normalizeRotation(value: unknown): ClipRotation {
  const numeric = typeof value === "number" ? value : Number(value);
  if (numeric === 1 || numeric === 2 || numeric === 3) {
    return numeric;
  }

  return 0;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await runCommand(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function cleanupFiles(files: Express.Multer.File[]): Promise<void> {
  await Promise.all(files.map((file) => rm(file.path, { force: true })));
}

async function cleanup(files: Express.Multer.File[], workDir?: string): Promise<void> {
  await cleanupFiles(files);

  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Backend merge failed.";
}
