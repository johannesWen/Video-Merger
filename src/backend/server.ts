import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import multer from "multer";
import type { OutputSettings } from "../shared/types";
import { buildBackendMergeArgs, buildProbeArgs, parseProbeOutput, type BackendClip } from "./ffmpegCommands";

const port = Number(process.env.PORT ?? 5174);
const upload = multer({
  dest: path.join(tmpdir(), "video-merger-uploads"),
  limits: {
    files: 50,
    fileSize: 4 * 1024 * 1024 * 1024
  }
});

const app = express();

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
  let workDir: string | undefined;

  try {
    if (files.length === 0) {
      response.status(400).json({ error: "Upload at least one MP4 file." });
      return;
    }

    const settings = parseSettings(request.body.settings);
    workDir = await mkdtemp(path.join(tmpdir(), "video-merger-"));
    const outputPath = path.join(workDir, "merged-video.mp4");

    const clips: BackendClip[] = [];
    for (const file of files) {
      const metadata = await probeFile(file.path);
      clips.push({ inputPath: file.path, metadata });
    }

    await runCommand("ffmpeg", buildBackendMergeArgs(clips, outputPath, settings));

    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Disposition", 'attachment; filename="merged-video.mp4"');

    const stream = createReadStream(outputPath);
    stream.pipe(response);
    stream.on("close", () => {
      void cleanup(files, workDir);
    });
    return;
  } catch (error) {
    await cleanup(files, workDir);
    response.status(500).json({ error: getErrorMessage(error) });
  }
});

app.listen(port, () => {
  console.log(`Backend FFmpeg API listening on http://localhost:${port}`);
});

async function probeFile(filePath: string) {
  const output = await runCommand("ffprobe", buildProbeArgs(filePath));
  return parseProbeOutput(output.stdout);
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

async function commandExists(command: string): Promise<boolean> {
  try {
    await runCommand(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function cleanup(files: Express.Multer.File[], workDir?: string): Promise<void> {
  await Promise.all(files.map((file) => rm(file.path, { force: true })));

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
