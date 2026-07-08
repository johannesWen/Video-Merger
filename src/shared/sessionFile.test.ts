import { describe, expect, it } from "vitest";
import {
  SessionValidationError,
  deriveStableClipId,
  getDirectoryFromPath,
  getFilePath,
  joinPath,
  parseSession,
  readFilePath,
  serializeSession,
  sessionFileBlob
} from "./sessionFile";
import { createVideoItem } from "./mediaUtils";
import type { VideoItem } from "./types";

function makeFile(name: string, lastModified: number, size = 1): File {
  const file = new File([new Uint8Array(size)], name, { type: "video/mp4", lastModified });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

function makeItem(overrides: Partial<VideoItem> = {}): VideoItem {
  const file = makeFile(overrides.name ?? "clip.mp4", overrides.createdAt ?? 1700000000000, overrides.size ?? 1);
  return {
    id: deriveStableClipId(file.name, file.lastModified, file.size),
    file,
    objectUrl: "blob:fake",
    name: file.name,
    size: file.size,
    mimeType: "video/mp4",
    createdAt: file.lastModified,
    status: "ready",
    rotation: 0,
    volume: 1,
    muted: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    colorAdjust: { brightness: 0, contrast: 1, saturation: 1 },
    ...overrides
  };
}

describe("sessionFile", () => {
  it("serializes a session and round-trips through parseSession", () => {
    const items: VideoItem[] = [
      makeItem({ name: "intro.mp4", rotation: 0 }),
      makeItem({ name: "outro.mp4", rotation: 1, trimSegments: [{ start: 0, end: 1.2345678 }, { start: 2, end: 4.5 }] })
    ];
    const settings = { width: 1920, height: 1080, aspectLabel: "16:9 1080p", aspectHandling: "fit-blur" as const, format: "mp4" as const, fps: 30, quality: 60, masterVolume: 1, outputName: "merged-video" };
    const session = serializeSession(items, settings, "auto");

    expect(session.version).toBe(1);
    expect(session.app).toBe("video-merger");
    expect(session.clips).toHaveLength(2);
    expect(session.clips[0]?.trimSegments).toBeUndefined();
    expect(session.clips[1]?.trimSegments).toEqual([{ start: 0, end: 1.235 }, { start: 2, end: 4.5 }]);

    const parsed = parseSession(JSON.stringify(session));
    expect(parsed.clips).toEqual(session.clips);
    expect(parsed.settings).toEqual(settings);
    expect(parsed.processingMode).toBe("auto");
  });

  it("preserves the absolute path stored on each VideoItem", () => {
    const items: VideoItem[] = [
      makeItem({ name: "intro.mp4", path: "/Users/me/footage/intro.mp4" }),
      makeItem({ name: "outro.mp4", path: "/Users/me/footage/sub/outro.mp4" })
    ];
    const session = serializeSession(items, { width: 1, height: 1, aspectLabel: "x", aspectHandling: "fit-blur", format: "mp4" }, "auto");
    expect(session.clips[0]?.path).toBe("/Users/me/footage/intro.mp4");
    expect(session.clips[1]?.path).toBe("/Users/me/footage/sub/outro.mp4");
  });

  it("captures Chromium's non-standard File.path when createVideoItem is given a file with a path", () => {
    const file = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4", lastModified: 1700000000000 });
    Object.defineProperty(file, "path", { configurable: true, value: "/Users/me/footage/clip.mp4" });

    expect(readFilePath(file)).toBe("/Users/me/footage/clip.mp4");

    const item = createVideoItem(file);
    expect(item.path).toBe("/Users/me/footage/clip.mp4");

    const session = serializeSession([item], { width: 1, height: 1, aspectLabel: "x", aspectHandling: "fit-blur", format: "mp4" }, "auto");
    expect(session.clips[0]?.path).toBe("/Users/me/footage/clip.mp4");
  });

  it("serializing twice produces identical output", () => {
    const items: VideoItem[] = [
      makeItem({ name: "a.mp4", rotation: 2, trimSegments: [{ start: 0.1, end: 0.2 }] })
    ];
    const settings = { width: 1280, height: 720, aspectLabel: "16:9 720p", aspectHandling: "center-crop" as const, format: "mp4" as const, fps: 30, quality: 60, masterVolume: 1, outputName: "merged-video" };
    const first = serializeSession(items, settings, "backend");
    const second = serializeSession(parseSession(JSON.stringify(first)).clips.map((clip) => makeItem({
      name: clip.name,
      createdAt: clip.createdAt,
      size: clip.size,
      rotation: clip.rotation,
      trimSegments: clip.trimSegments
    })), settings, "backend");

    expect(second.clips).toEqual(first.clips);
    expect(second.settings).toEqual(first.settings);
    expect(second.processingMode).toEqual(first.processingMode);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseSession("{not json")).toThrow(SessionValidationError);
  });

  it("rejects unknown app", () => {
    const bad = JSON.stringify({ app: "other", version: 1, clips: [] });
    expect(() => parseSession(bad)).toThrow(/not a video-merger session/);
  });

  it("rejects unsupported version", () => {
    const bad = JSON.stringify({ app: "video-merger", version: 99, clips: [] });
    expect(() => parseSession(bad)).toThrow(/Unsupported session version 99/);
  });

  it("rejects clips with invalid rotation", () => {
    const bad = JSON.stringify({
      app: "video-merger",
      version: 1,
      savedAt: 0,
      settings: { width: 1, height: 1, aspectLabel: "x", aspectHandling: "fit-blur" },
      processingMode: "auto",
      clips: [{ id: "a", name: "a.mp4", size: 1, mimeType: "video/mp4", createdAt: 0, path: "a.mp4", rotation: 7 }]
    });
    expect(() => parseSession(bad)).toThrow(/rotation is invalid/);
  });

  it("rejects trim segments with end < start", () => {
    const bad = JSON.stringify({
      app: "video-merger",
      version: 1,
      savedAt: 0,
      settings: { width: 1, height: 1, aspectLabel: "x", aspectHandling: "fit-blur" },
      processingMode: "auto",
      clips: [{
        id: "a",
        name: "a.mp4",
        size: 1,
        mimeType: "video/mp4",
        createdAt: 0,
        path: "a.mp4",
        rotation: 0,
        trimSegments: [{ start: 5, end: 2 }]
      }]
    });
    expect(() => parseSession(bad)).toThrow(/end .* is before start/);
  });

  it("builds a JSON blob from the session", () => {
    const session = serializeSession([], { width: 1, height: 1, aspectLabel: "x", aspectHandling: "fit-blur", format: "mp4" }, "auto");
    const blob = sessionFileBlob(session);
    expect(blob.type).toBe("application/json");
  });

  it("derives a stable id from file metadata", () => {
    const id = deriveStableClipId("a.mp4", 123, 456);
    expect(id).toBe("a.mp4-123-456");
  });

  it("falls back to webkitRelativePath when file.path is missing", () => {
    const file = new File(["x"], "a.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "webkitRelativePath", { value: "folder/a.mp4" });
    expect(getFilePath(file)).toBe("folder/a.mp4");
  });

  it("falls back to the file name when no path info is present", () => {
    const file = new File(["x"], "a.mp4", { type: "video/mp4" });
    expect(getFilePath(file)).toBe("a.mp4");
  });
});

describe("path utilities", () => {
  it("extracts the directory from a Unix absolute path", () => {
    expect(getDirectoryFromPath("/Users/me/footage/clip1.mp4")).toBe("/Users/me/footage");
  });

  it("extracts the directory from a Windows-style absolute path", () => {
    expect(getDirectoryFromPath("C:\\Users\\me\\footage\\clip1.mp4")).toBe("C:\\Users\\me\\footage");
  });

  it("returns undefined when there is no directory", () => {
    expect(getDirectoryFromPath("clip1.mp4")).toBeUndefined();
    expect(getDirectoryFromPath("")).toBeUndefined();
  });

  it("joins a directory and a filename with a slash", () => {
    expect(joinPath("/Users/me/footage", "clip1.mp4")).toBe("/Users/me/footage/clip1.mp4");
    expect(joinPath("/Users/me/footage/", "clip1.mp4")).toBe("/Users/me/footage/clip1.mp4");
  });

  it("simulates the load flow: derives absolute paths for clips stored as filenames", () => {
    const jsonPath = "/Users/me/footage/video-merger-session.json";
    const jsonDirectory = getDirectoryFromPath(jsonPath);
    expect(jsonDirectory).toBe("/Users/me/footage");

    const storedClipPaths = ["clip1.mp4", "clip2.mp4"];
    const resolved = storedClipPaths.map((p) => {
      if (getDirectoryFromPath(p)) {
        return p;
      }
      return joinPath(jsonDirectory!, p);
    });
    expect(resolved).toEqual([
      "/Users/me/footage/clip1.mp4",
      "/Users/me/footage/clip2.mp4"
    ]);
  });
});
