import { describe, expect, it } from "vitest";
import {
  buildSegmentFilter,
  createCrossfadeConcatArgs,
  getVideoBitrate,
  segmentOutputDuration,
  textOverlayYRatio,
  type CrossfadeSegment
} from "./ffmpegSegments";
import type { OutputSettings, VideoItem } from "../shared/types";

const settings: OutputSettings = {
  width: 1280,
  height: 720,
  aspectLabel: "16:9 720p",
  aspectHandling: "fit-blur",
  format: "mp4",
  fps: 30,
  quality: 60,
  masterVolume: 1,
  outputName: "merged-video"
};

function makeItem(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    id: "clip-1",
    file: new File([], "a.mp4"),
    objectUrl: "blob:a",
    name: "a.mp4",
    size: 1000,
    mimeType: "video/mp4",
    createdAt: 0,
    metadata: { duration: 10, width: 1280, height: 720, aspectRatio: 16 / 9, hasAudio: true },
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

const fullSegments = [{ start: 0, end: 10 }];

describe("segment filter edge cases", () => {
  it("clamps fades longer than the clip duration to half the output duration", () => {
    const item = makeItem({ fadeIn: 40, fadeOut: 40 });
    const filter = buildSegmentFilter(settings, item, fullSegments, true);
    expect(filter).toContain("fade=t=in:st=0:d=5.000");
    expect(filter).toContain("fade=t=out:st=5.000:d=5.000");
    expect(filter).toContain("afade=t=in:st=0:d=5.000");
    expect(filter).toContain("afade=t=out:st=5.000:d=5.000");
  });

  it("ignores zero and negative fades", () => {
    const item = makeItem({ fadeIn: 0, fadeOut: -3 });
    const filter = buildSegmentFilter(settings, item, fullSegments, true);
    expect(filter).not.toContain("fade=");
  });

  it("treats non-positive speed as 1x and emits no setpts/atempo", () => {
    const item = makeItem({ speed: 0 });
    const filter = buildSegmentFilter(settings, item, fullSegments, true);
    expect(filter).not.toContain("setpts=PTS/");
    expect(filter).not.toContain("atempo");
    expect(segmentOutputDuration(item, fullSegments)).toBeCloseTo(10);
  });

  it("clamps audio tempo to ffmpeg's supported 0.5-2 range at speed extremes", () => {
    const slow = buildSegmentFilter(settings, makeItem({ speed: 0.25 }), fullSegments, true);
    expect(slow).toContain("setpts=PTS/0.250");
    expect(slow).toContain("atempo=0.500");
    const fast = buildSegmentFilter(settings, makeItem({ speed: 4 }), fullSegments, true);
    expect(fast).toContain("setpts=PTS/4.000");
    expect(fast).toContain("atempo=2.000");
  });

  it("does not emit invalid filters for a zero-duration clip", () => {
    const item = makeItem({
      metadata: { duration: 0, width: 1280, height: 720, aspectRatio: 16 / 9, hasAudio: true },
      fadeIn: 2,
      fadeOut: 2
    });
    const filter = buildSegmentFilter(settings, item, [], true);
    expect(filter).not.toContain("d=0.000");
    expect(filter).not.toContain("NaN");
    expect(filter).not.toContain("Infinity");
  });

  it("adds reverse/areverse, freeze-frame tpad/apad and master volume", () => {
    const item = makeItem({ reversed: true, freezeFrame: 2, volume: 0.5 });
    const filter = buildSegmentFilter(settings, item, fullSegments, true, undefined);
    expect(filter).toContain("reverse");
    expect(filter).toContain("areverse");
    expect(filter).toContain("tpad=stop_mode=clone:stop_duration=2.000");
    expect(filter).toContain("apad=pad_dur=2.000");
    expect(filter).toContain("volume=0.500");
  });

  it("applies masterVolume from output settings and clamps it to 0-2", () => {
    const loud = buildSegmentFilter({ ...settings, masterVolume: 5 }, makeItem(), fullSegments, true);
    expect(loud).toContain("volume=2.000");
    const mutedMaster = buildSegmentFilter({ ...settings, masterVolume: 0 }, makeItem(), fullSegments, true);
    expect(mutedMaster).toContain("volume=0.000");
  });

  it("routes the text overlay input through an overlay filter into [v]", () => {
    const filter = buildSegmentFilter(settings, makeItem(), fullSegments, true, 1);
    expect(filter).toContain("[vfx][1:v]overlay=0:0:format=auto[v]");
  });

  it("includes freeze-frame hold in the segment output duration", () => {
    const item = makeItem({ speed: 2, freezeFrame: 3 });
    expect(segmentOutputDuration(item, fullSegments)).toBeCloseTo(10 / 2 + 3);
  });
});

describe("crossfade concat graph", () => {
  const seg = (duration: number, crossfadeAfter: number): CrossfadeSegment => ({
    path: `seg${duration}.ts`,
    duration,
    crossfadeAfter
  });

  it("requires at least two segments", () => {
    expect(() => createCrossfadeConcatArgs([seg(5, 1)], "out.mp4", settings)).toThrow();
  });

  it("builds xfade + acrossfade with a correct offset", () => {
    const args = createCrossfadeConcatArgs([seg(6, 1), seg(4, 0)], "out.mp4", settings);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("xfade=transition=fade:duration=1.000:offset=5.000");
    expect(graph).toContain("acrossfade=d=1.000");
  });

  it("falls back to plain concat for zero-fade gaps", () => {
    const args = createCrossfadeConcatArgs([seg(6, 0), seg(4, 0)], "out.mp4", settings);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("concat=n=2:v=1:a=1");
    expect(graph).not.toContain("xfade");
  });

  it("clamps the fade below the shorter neighboring segment's duration", () => {
    const args = createCrossfadeConcatArgs([seg(6, 5), seg(0.5, 0)], "out.mp4", settings);
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Fade must be capped to currentDuration - 0.05 = 0.45s, not the requested 5s.
    expect(graph).toContain("xfade=transition=fade:duration=0.450");
  });

  it("maps the final chained labels and re-encodes", () => {
    const args = createCrossfadeConcatArgs([seg(3, 1), seg(3, 0.5), seg(3, 0)], "out.mp4", settings);
    expect(args).toContain("[vx2]");
    expect(args).toContain("[ax2]");
    expect(args).toContain("libx264");
    expect(args[args.length - 1]).toBe("out.mp4");
  });
});

describe("bitrate quality scaling", () => {
  it("scales the base bitrate with the quality setting", () => {
    expect(getVideoBitrate({ ...settings, quality: 60 })).toBe("2800k");
    expect(getVideoBitrate({ ...settings, quality: 30 })).toBe("1400k");
    expect(getVideoBitrate({ ...settings, quality: 100 })).toBe("4667k");
  });

  it("never drops below the 500k floor and clamps out-of-range quality", () => {
    expect(getVideoBitrate({ ...settings, width: 320, height: 240, quality: 5 })).toBe("600k");
    expect(getVideoBitrate({ ...settings, quality: Number.NaN })).toBe("2800k");
  });
});

describe("text overlay placement", () => {
  it("maps positions to vertical ratios", () => {
    expect(textOverlayYRatio("top")).toBeLessThan(textOverlayYRatio("center"));
    expect(textOverlayYRatio("center")).toBeLessThan(textOverlayYRatio("bottom"));
  });
});
