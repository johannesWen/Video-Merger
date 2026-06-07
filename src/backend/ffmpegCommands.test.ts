import { describe, expect, it } from "vitest";
import { defaultOutputSettings } from "../shared/mediaUtils";
import type { VideoMetadata } from "../shared/types";
import { buildBackendMergeArgs, buildProbeArgs, parseProbeOutput } from "./ffmpegCommands";

describe("backend ffmpeg commands", () => {
  it("builds a native ffmpeg merge command for multiple clips", () => {
    const args = buildBackendMergeArgs(
      [
        { inputPath: "/tmp/a.mp4", metadata: makeMetadata(true) },
        { inputPath: "/tmp/b.mp4", metadata: makeMetadata(false) }
      ],
      "/tmp/out.mp4",
      defaultOutputSettings
    );
    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(args).toContain("/tmp/a.mp4");
    expect(args).toContain("/tmp/b.mp4");
    expect(args).toContain("libx264");
    expect(args).toContain("veryfast");
    expect(filterGraph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]");
    expect(filterGraph).toContain("anullsrc=channel_layout=stereo:sample_rate=44100");
  });

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
});

function makeMetadata(hasAudio: boolean): VideoMetadata {
  return {
    duration: 4,
    width: 1280,
    height: 720,
    aspectRatio: 16 / 9,
    hasAudio
  };
}
