import { describe, expect, it } from "vitest";
import {
  defaultSegments,
  effectiveDuration,
  findNextKeptStart,
  findSegmentIndexAt,
  isPristine,
  isTimeInKeptRegion,
  joinWithNext,
  normalizeSegments,
  removeSegment,
  setSegmentEnd,
  setSegmentStart,
  splitAt,
  totalKeptDuration
} from "./trimSegments";

describe("trim segments", () => {
  it("returns a single full range by default", () => {
    expect(defaultSegments(10)).toEqual([{ start: 0, end: 10 }]);
    expect(defaultSegments(0)).toEqual([]);
    expect(defaultSegments(Number.NaN)).toEqual([]);
  });

  it("normalises segments by clamping, sorting, and dropping empties", () => {
    expect(
      normalizeSegments(
        [
          { start: -2, end: 4 },
          { start: 9, end: 12 },
          { start: 5, end: 5 }
        ],
        10
      )
    ).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 10 }
    ]);
  });

  it("falls back to the full range when input is missing or empty after sanitisation", () => {
    expect(normalizeSegments(undefined, 8)).toEqual([{ start: 0, end: 8 }]);
    expect(normalizeSegments([], 8)).toEqual([{ start: 0, end: 8 }]);
    expect(normalizeSegments([{ start: 4, end: 4 }], 8)).toEqual([{ start: 0, end: 8 }]);
  });

  it("sums the kept duration across segments", () => {
    expect(totalKeptDuration([{ start: 0, end: 2 }, { start: 5, end: 8 }])).toBe(5);
    expect(totalKeptDuration(undefined)).toBe(0);
  });

  it("detects the pristine (untouched) state", () => {
    expect(isPristine(undefined, 10)).toBe(true);
    expect(isPristine([{ start: 0, end: 10 }], 10)).toBe(true);
    expect(isPristine([{ start: 0.5, end: 10 }], 10)).toBe(false);
    expect(isPristine([{ start: 0, end: 5 }, { start: 5, end: 10 }], 10)).toBe(false);
  });

  it("finds the segment that contains a given time", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 9 }
    ];

    expect(findSegmentIndexAt(segments, 0)).toBe(0);
    expect(findSegmentIndexAt(segments, 1.5)).toBe(0);
    expect(findSegmentIndexAt(segments, 2)).toBe(1);
    expect(findSegmentIndexAt(segments, 7)).toBe(1);
    expect(findSegmentIndexAt(segments, 12)).toBe(1);
  });

  it("detects whether a time falls inside a kept region", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 9 }
    ];

    expect(isTimeInKeptRegion(segments, 0)).toBe(true);
    expect(isTimeInKeptRegion(segments, 1)).toBe(true);
    expect(isTimeInKeptRegion(segments, 1.999)).toBe(true);
    expect(isTimeInKeptRegion(segments, 2)).toBe(false);
    expect(isTimeInKeptRegion(segments, 3)).toBe(false);
    expect(isTimeInKeptRegion(segments, 5)).toBe(true);
    expect(isTimeInKeptRegion(segments, 9)).toBe(false);
    expect(isTimeInKeptRegion(segments, 12)).toBe(false);
    expect(isTimeInKeptRegion([], 5)).toBe(false);
  });

  it("finds the next kept region start for a time inside a cut", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 9 }
    ];

    expect(findNextKeptStart(segments, 0)).toBe(0);
    expect(findNextKeptStart(segments, 1)).toBe(1);
    expect(findNextKeptStart(segments, 2)).toBe(5);
    expect(findNextKeptStart(segments, 3)).toBe(5);
    expect(findNextKeptStart(segments, 5)).toBe(5);
    expect(findNextKeptStart(segments, 7)).toBe(7);
    expect(findNextKeptStart(segments, 9)).toBeUndefined();
    expect(findNextKeptStart([], 1)).toBeUndefined();
  });

  it("splits a segment at the playhead with a small safety margin", () => {
    const segments = [{ start: 0, end: 10 }];

    expect(splitAt(segments, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 }
    ]);

    expect(splitAt(segments, 0)).toEqual(segments);
    expect(splitAt(segments, 10)).toEqual(segments);
    expect(splitAt(segments, 0.0001)).toEqual(segments);
  });

  it("only splits the segment that contains the playhead", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 9 }
    ];

    expect(splitAt(segments, 7)).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
      { start: 7, end: 9 }
    ]);
  });

  it("removes a segment without leaving a gap", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 7 },
      { start: 8, end: 10 }
    ];

    expect(removeSegment(segments, 1)).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 }
    ]);
    expect(removeSegment(segments, 0)).toEqual([
      { start: 5, end: 7 },
      { start: 8, end: 10 }
    ]);
    expect(removeSegment(segments, 0)).not.toBe(segments);
  });

  it("joins a segment with the next one, removing the cut between them", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 8 },
      { start: 10, end: 12 }
    ];

    expect(joinWithNext(segments, 0)).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 12 }
    ]);
    expect(joinWithNext(segments, 1)).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 12 }
    ]);
  });

  it("refuses to join the last segment (no neighbour)", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 8 }
    ];

    expect(joinWithNext(segments, 1)).toEqual(segments);
    expect(joinWithNext(segments, -1)).toEqual(segments);
    expect(joinWithNext(segments, 5)).toEqual(segments);
  });

  it("clamps start moves against the previous segment and the source end", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 9 },
      { start: 12, end: 14 }
    ];

    expect(setSegmentStart(segments, 1, 4, 14)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 9 },
      { start: 12, end: 14 }
    ]);
    expect(setSegmentStart(segments, 1, 6, 14)).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 9 },
      { start: 12, end: 14 }
    ]);
    expect(setSegmentStart(segments, 0, -1, 14)).toEqual(segments);
  });

  it("clamps end moves against the next segment and the source duration", () => {
    const segments = [
      { start: 0, end: 2 },
      { start: 5, end: 9 },
      { start: 12, end: 14 }
    ];

    expect(setSegmentEnd(segments, 1, 4, 14)).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 5.001 },
      { start: 12, end: 14 }
    ]);
    expect(setSegmentEnd(segments, 1, 11, 14)).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 11 },
      { start: 12, end: 14 }
    ]);
    expect(setSegmentEnd(segments, 2, 20, 14)).toEqual(segments);
  });

  it("computes the effective duration from trim segments or metadata", () => {
    expect(effectiveDuration({ metadata: { duration: 10, width: 1, height: 1, aspectRatio: 1, hasAudio: false } })).toBe(10);
    expect(
      effectiveDuration({
        metadata: { duration: 10, width: 1, height: 1, aspectRatio: 1, hasAudio: false },
        trimSegments: [
          { start: 0, end: 3 },
          { start: 7, end: 9 }
        ]
      })
    ).toBe(5);
    expect(effectiveDuration({})).toBe(0);
  });
});
