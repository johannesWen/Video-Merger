import { describe, expect, it } from "vitest";
import {
  createRemuxSegmentsArgs,
  createSegmentArgs,
  formatFfmpegTime,
  getVideoBitrate,
  parseFfmpegProgressLine,
  parseProbeOutput,
  parseTrimSegments,
  progressRatio
} from "./ffmpegCommands";

describe("backend ffmpeg commands", () => {
  it("builds ffprobe json args", () => {
    expect(buildProbeArgs("/tmp/clip.mp4")).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "/tmp/clip.mp4"
    ]);
  });

  it("parses ffprobe stream metadata", () => {
    const metadata = parseProbeOutput(
      JSON.stringify({
        streams: [
          { codec_type: "video", width: 1920, height: 1080, duration: "5.2" },
          { codec_type: "audio" }
        ],
        format: { duration: "5.3" }
      })
    );

    expect(metadata).toEqual({
      duration: 5.2,
      width: 1920,
      height: 1080,
      aspectRatio: 16 / 9,
      hasAudio: true
    });
  });

  it("parses ffmpeg progress lines", () => {
    expect(parseFfmpegProgressLine("out_time_us=12345678")).toEqual({ currentTimeUs: 12345678, done: false });
    expect(parseFfmpegProgressLine("out_time=00:00:04.000000")).toEqual({ currentTimeUs: 4_000_000, done: false });
    expect(parseFfmpegProgressLine("out_time=00:01:30.500000")).toEqual({ currentTimeUs: 90_500_000, done: false });
    expect(parseFfmpegProgressLine("out_time=01:02:03.123456")).toEqual({ currentTimeUs: 3_723_123_456, done: false });
    expect(parseFfmpegProgressLine("out_time=N/A")).toEqual({ currentTimeUs: undefined, done: false });
    expect(parseFfmpegProgressLine("progress=continue")).toEqual({ currentTimeUs: undefined, done: false });
    expect(parseFfmpegProgressLine("progress=end")).toEqual({ currentTimeUs: undefined, done: true });
    expect(parseFfmpegProgressLine("frame=42")).toEqual({ currentTimeUs: undefined, done: false });
    expect(parseFfmpegProgressLine("")).toEqual({ currentTimeUs: undefined, done: false });
    expect(parseFfmpegProgressLine("out_time_us=not-a-number")).toEqual({ currentTimeUs: undefined, done: false });
  });

  it("computes progress ratios against the total duration", () => {
    expect(progressRatio(5_000_000, 10)).toBeCloseTo(0.5, 5);
    expect(progressRatio(0, 10)).toBe(0);
    expect(progressRatio(15_000_000, 10)).toBe(1);
    expect(progressRatio(Number.NaN, 10)).toBe(0);
    expect(progressRatio(1_000_000, 0)).toBe(0);
    expect(progressRatio(-1_000_000, 10)).toBe(0);
  });

  it("formats times as zero-padded HH:MM:SS", () => {
    expect(formatFfmpegTime(0)).toBe("00:00:00");
    expect(formatFfmpegTime(65)).toBe("00:01:05");
    expect(formatFfmpegTime(3661)).toBe("01:01:01");
    expect(formatFfmpegTime(-5)).toBe("00:00:00");
    expect(formatFfmpegTime(Number.NaN)).toBe("00:00:00");
  });

  it("re-exports the shared segment and bitrate helpers", () => {
    expect(typeof createSegmentArgs).toBe("function");
    expect(typeof createRemuxSegmentsArgs).toBe("function");
    expect(typeof getVideoBitrate).toBe("function");
  });

  it("parses trim segment lists from the request body", () => {
    expect(parseTrimSegments("not-json", 2)).toEqual([undefined, undefined]);
    expect(parseTrimSegments(JSON.stringify([{ start: 0, end: 1 }]), 2)).toEqual([undefined, undefined]);
    expect(parseTrimSegments(undefined, 2)).toEqual([undefined, undefined]);

    expect(
      parseTrimSegments(
        JSON.stringify([
          [
            { start: 0, end: 2 },
            { start: 5, end: 8 }
          ],
          []
        ]),
        2
      )
    ).toEqual([
      [
        { start: 0, end: 2 },
        { start: 5, end: 8 }
      ],
      undefined
    ]);
  });

  it("drops invalid trim segment entries while keeping the rest of the list", () => {
    const parsed = parseTrimSegments(
      JSON.stringify([
        [
          { start: 0, end: 1 },
          { start: 5, end: 5 },
          { start: "x", end: 2 },
          { end: 3 },
          { start: 4, end: 6 }
        ]
      ]),
      1
    );

    expect(parsed).toEqual([
      [
        { start: 0, end: 1 },
        { start: 4, end: 6 }
      ]
    ]);
  });
});

function buildProbeArgs(inputPath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath];
}
