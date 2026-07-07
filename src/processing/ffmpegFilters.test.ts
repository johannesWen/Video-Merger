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
    expect(filter).toContain("scale=1920:1080:force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1920:1080");
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
    expect(args).toContain("4500k");
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("fps=30");
    expect(args.at(-1)).toBe("segment.ts");
  });

  it("keeps the original single-source filter when no trim segments are set", () => {
    const args = createSegmentArgs("input.mp4", "segment.ts", makeItem(true), defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];

    expect(filter.startsWith("[0:v]split=2")).toBe(true);
    expect(filter).not.toContain("trim=");
    expect(filter).not.toContain("atrim=");
  });

  it("adds a single trim+setpts when the kept range is a contiguous sub-clip", () => {
    const item = makeItem(true, { trimSegments: [{ start: 1.5, end: 4 }] });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];

    expect(filter).toContain("[0:v]trim=start=1.500:end=4.000,setpts=PTS-STARTPTS[vcraw]");
    expect(filter).toContain("[0:a]atrim=start=1.500:end=4.000,asetpts=PTS-STARTPTS[acraw]");
    expect(filter).toContain("[acraw]volume=1.000[ac]");
    expect(filter).toContain("boxblur=24:2");
  });

  it("adds a trim+concat graph when the clip has multiple kept ranges", () => {
    const item = makeItem(true, {
      metadata: { duration: 10, width: 1280, height: 720, aspectRatio: 16 / 9, hasAudio: true },
      trimSegments: [
        { start: 0, end: 2 },
        { start: 5, end: 8 }
      ]
    });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];

    expect(filter).toContain("[0:v]split=2[v0src][v1src]");
    expect(filter).toContain("[v0src]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0]");
    expect(filter).toContain("[v1src]trim=start=5.000:end=8.000,setpts=PTS-STARTPTS[v1]");
    expect(filter).toContain("[v0][v1]concat=n=2:v=1:a=0[vcraw]");
    expect(filter).toContain("[0:a]asplit=2[a0src][a1src]");
    expect(filter).toContain("[a0src]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0]");
    expect(filter).toContain("[a0][a1]concat=n=2:v=0:a=1[acraw]");
    expect(filter).toContain("boxblur=24:2");
    expect(args[args.indexOf("-map", args.indexOf("[v]") + 1) + 1]).toBe("[ac]");
  });

  it("uses the kept duration for the silent audio fallback when the clip has no audio", () => {
    const item = makeItem(false, {
      metadata: { duration: 10, width: 1280, height: 720, aspectRatio: 16 / 9, hasAudio: false },
      trimSegments: [
        { start: 0, end: 2 },
        { start: 5, end: 8 }
      ]
    });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);

    expect(args).toContain("5.000");
    expect(args).toContain("anullsrc=channel_layout=stereo:sample_rate=44100");
    const tIndex = args.indexOf("-t");
    expect(tIndex).toBeGreaterThan(-1);
    expect(args[tIndex + 1]).toBe("5.000");
  });

  it("falls back to a single contiguous range for an empty trim list", () => {
    const item = makeItem(true, { trimSegments: [] });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];

    expect(filter.startsWith("[0:v]split=2")).toBe(true);
    expect(filter).not.toContain("trim=");
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

function makeItem(hasAudio: boolean, overrides: Partial<VideoItem> = {}): VideoItem {
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
    volume: 1,
    muted: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    colorAdjust: { brightness: 0, contrast: 1, saturation: 1 },
    metadata: {
      duration: 4,
      width: 1280,
      height: 720,
      aspectRatio: 16 / 9,
      hasAudio
    },
    ...overrides
  };
}

describe("per-clip effects", () => {
  it("applies volume and mute to the audio chain", () => {
    const item = makeItem(true, { volume: 0.5 });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("volume=0.500");

    const muted = makeItem(true, { muted: true });
    const mutedArgs = createSegmentArgs("input.mp4", "segment.ts", muted, defaultOutputSettings);
    const mutedFilter = mutedArgs[mutedArgs.indexOf("-filter_complex") + 1];
    expect(mutedFilter).toContain("volume=0.000");
  });

  it("applies speed to both video (setpts) and audio (atempo)", () => {
    const item = makeItem(true, { speed: 1.5 });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("setpts=PTS/1.500");
    expect(filter).toContain("atempo=1.500");
  });

  it("applies fade in/out to video and audio", () => {
    const item = makeItem(true, { fadeIn: 1, fadeOut: 1 });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("fade=t=in:st=0:d=1.000");
    expect(filter).toContain("fade=t=out:st=3.000:d=1.000");
    expect(filter).toContain("afade=t=in:st=0:d=1.000");
    expect(filter).toContain("afade=t=out:st=3.000:d=1.000");
  });

  it("applies brightness/contrast/saturation via the eq filter", () => {
    const item = makeItem(true, { colorAdjust: { brightness: 0.2, contrast: 1.1, saturation: 0.8 } });
    const args = createSegmentArgs("input.mp4", "segment.ts", item, defaultOutputSettings);
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("eq=brightness=0.200:contrast=1.100:saturation=0.800");
  });
});
