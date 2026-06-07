import { describe, expect, it, vi } from "vitest";
import {
  defaultOutputSettings,
  isMp4File,
  reorderItems,
  sortByCreationDate,
  validateVideoFiles
} from "./mediaUtils";
import type { VideoItem } from "./types";

describe("media utilities", () => {
  it("sorts uploaded videos by file timestamp and then name", () => {
    const items = [
      makeItem("third.mp4", 3000),
      makeItem("alpha.mp4", 1000),
      makeItem("beta.mp4", 1000)
    ];

    expect(sortByCreationDate(items).map((item) => item.name)).toEqual(["alpha.mp4", "beta.mp4", "third.mp4"]);
  });

  it("reorders items without mutating the original array", () => {
    const items = ["a", "b", "c", "d"];

    expect(reorderItems(items, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(items).toEqual(["a", "b", "c", "d"]);
  });

  it("validates MP4 files and rejects other formats", () => {
    const mp4 = new File(["video"], "clip.mp4", { type: "video/mp4" });
    const mov = new File(["video"], "clip.mov", { type: "video/quicktime" });

    expect(isMp4File(mp4)).toBe(true);
    expect(validateVideoFiles([mp4])).toEqual([]);
    expect(validateVideoFiles([mov])).toEqual(["clip.mov is not an MP4 file."]);
    expect(validateVideoFiles([])).toEqual(["Choose at least one MP4 file."]);
  });

  it("keeps landscape MP4 defaults", () => {
    expect(defaultOutputSettings).toMatchObject({
      width: 1280,
      height: 720,
      aspectLabel: "16:9 720p",
      aspectHandling: "fit-blur",
      format: "mp4"
    });
  });
});

function makeItem(name: string, createdAt: number): VideoItem {
  return {
    id: name,
    file: new File(["video"], name, { type: "video/mp4", lastModified: createdAt }),
    objectUrl: `blob:${name}`,
    name,
    size: 5,
    mimeType: "video/mp4",
    createdAt,
    status: "ready"
  };
}

vi.stubGlobal("URL", {
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn()
});
