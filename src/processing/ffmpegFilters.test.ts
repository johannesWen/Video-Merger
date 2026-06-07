import { describe, expect, it } from "vitest";
import { defaultOutputSettings } from "../shared/mediaUtils";
import type { VideoItem } from "../shared/types";
import {
  createConcatArgs,
  createNormalizeArgs,
  createRemuxSegmentsArgs,
  createSegmentArgs,
  createSinglePassMergeArgs,
  getVideoBitrate
} from "./BrowserFfmpegEngine";
import { buildVideoFilter } from "./ffmpegFilters";

describe("ffmpeg filters", () => {
  it("constructs the default 16:9 blurred-fit video filter", () => {
    const filter = buildVideoFilter(defaultOutputSettings);

    expect(filter).toContain("[0:v]split=2");
    expect(filter).toContain("scale=1280:720:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1280:720");
    expect(filter).toContain("boxblur=24:2");
    expect(filter).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(filter).toContain("format=yuv420p[v]");
  });

  it("prepends a single transpose=1 for 90° rotation", () => {
    const filter = buildVideoFilter(defaultOutputSettings, 1);

    expect(filter.startsWith("[0:v]transpose=1,split=2")).toBe(true);
  });

  it("prepends two transpose=1 filters for 180° rotation", () => {
    const filter = buildVideoFilter(defaultOutputSettings, 2);

    expect(filter.startsWith("[0:v]transpose=1,transpose=1,split=2")).toBe(true);
  });

  it("prepends transpose=2 for 270° rotation", () => {
    const filter = buildVideoFilter(defaultOutputSettings, 3);

    expect(filter.startsWith("[0:v]transpose=2,split=2")).toBe(true);
  });

  it("applies the rotation prefix to the letterbox chain", () => {
    const settings = { ...defaultOutputSettings, aspectHandling: "letterbox" as const };
    const filter = buildVideoFilter(settings, 1);

    expect(filter.startsWith("[0:v]transpose=1,scale=")).toBe(true);
    expect(filter).toContain("pad=1920:1080");
  });

  it("adds a silent fallback audio source when a clip has no audio", () => {
    const item = makeItem(false);
    const args = createNormalizeArgs("input.mp4", "clip.mp4", item, defaultOutputSettings);

    expect(args).toContain("anullsrc=channel_layout=stereo:sample_rate=44100");
    expect(args).toContain("1:a:0");
    expect(args).toContain("-shortest");
  });

  it("maps original audio when a clip has audio", () => {
    const item = makeItem(true);
    const args = createNormalizeArgs("input.mp4", "clip.mp4", item, defaultOutputSettings);

    expect(args).toContain("0:a:0");
    expect(args).not.toContain("anullsrc=channel_layout=stereo:sample_rate=44100");
  });

  it("re-encodes the final concat output instead of stream-copying it", () => {
    const args = createConcatArgs("concat.txt", "merged.mp4");

    expect(args).toContain("+genpts");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args).not.toContain("copy");
  });

  it("builds a single-pass merge command with unique labels for multiple clips", () => {
    const items = [makeItem(true), makeItem(false), makeItem(true)];
    const args = createSinglePassMergeArgs(["a.mp4", "b.mp4", "c.mp4"], "merged.mp4", items, defaultOutputSettings);
    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(args.slice(0, 6)).toEqual(["-i", "a.mp4", "-i", "b.mp4", "-i", "c.mp4"]);
    expect(filterGraph).toContain("[v0bg]");
    expect(filterGraph).toContain("[v1bg]");
    expect(filterGraph).toContain("[v2bg]");
    expect(filterGraph).toContain("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][aout]");
    expect(filterGraph).toContain("anullsrc=channel_layout=stereo:sample_rate=44100");
  });

  it("encodes each clip as a concat-friendly transport stream segment", () => {
    const args = createSegmentArgs("input.mp4", "segment.ts", makeItem(true), defaultOutputSettings);

    expect(args).toContain("mpegts");
    expect(args).toContain("h264_mp4toannexb");
    expect(args).toContain("+resend_headers");
    expect(args).toContain("2800k");
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("fps=30");
    expect(args.at(-1)).toBe("segment.ts");
  });

  it("remuxes transport stream segments into the final MP4", () => {
    const args = createRemuxSegmentsArgs(["segment-0.ts", "segment-1.ts"], "merged.mp4");

    expect(args).toContain("file,concat");
    expect(args).toContain("concat:segment-0.ts|segment-1.ts");
    expect(args).toContain("copy");
    expect(args).toContain("aac_adtstoasc");
  });

  it("chooses bounded browser bitrates by output size", () => {
    expect(getVideoBitrate({ ...defaultOutputSettings, width: 1920, height: 1080 })).toBe("4500k");
    expect(getVideoBitrate({ ...defaultOutputSettings, width: 1280, height: 720 })).toBe("2800k");
    expect(getVideoBitrate({ ...defaultOutputSettings, width: 640, height: 360 })).toBe("1800k");
  });
});

function makeItem(hasAudio: boolean): VideoItem {
  return {
    id: "clip",
    file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
    objectUrl: "blob:clip",
    name: "clip.mp4",
    size: 5,
    mimeType: "video/mp4",
    createdAt: 1,
    status: "ready",
    rotation: 0,
    metadata: {
      duration: 4,
      width: 1280,
      height: 720,
      aspectRatio: 16 / 9,
      hasAudio
    }
  };
}
