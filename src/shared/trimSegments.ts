import type { TrimSegment, VideoMetadata } from "./types";

const EPSILON = 1e-3;

export function defaultSegments(duration: number): TrimSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    return [];
  }

  return [{ start: 0, end: duration }];
}

export function normalizeSegments(segments: TrimSegment[] | undefined, duration: number): TrimSegment[] {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (total <= 0) {
    return [];
  }

  if (!segments || segments.length === 0) {
    return defaultSegments(total);
  }

  const sanitized: TrimSegment[] = [];
  for (const segment of segments) {
    if (!segment || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      continue;
    }

    const start = Math.max(0, Math.min(segment.start, total));
    const end = Math.max(start, Math.min(segment.end, total));
    if (end - start < EPSILON) {
      continue;
    }

    sanitized.push({ start, end });
  }

  if (sanitized.length === 0) {
    return defaultSegments(total);
  }

  sanitized.sort((a, b) => a.start - b.start);
  return sanitized;
}

export function totalKeptDuration(segments: TrimSegment[] | undefined): number {
  if (!segments) {
    return 0;
  }

  return segments.reduce((sum, segment) => sum + Math.max(0, segment.end - segment.start), 0);
}

export function isPristine(segments: TrimSegment[] | undefined, duration: number): boolean {
  if (!segments) {
    return true;
  }

  if (segments.length !== 1) {
    return false;
  }

  const [only] = segments;
  return Math.abs(only.start) < EPSILON && Math.abs(only.end - duration) < EPSILON;
}

export function findSegmentIndexAt(segments: TrimSegment[], time: number): number {
  for (const [index, segment] of segments.entries()) {
    if (time >= segment.start - EPSILON && time < segment.end - EPSILON) {
      return index;
    }
  }

  return segments.length - 1;
}

export function isTimeInKeptRegion(segments: TrimSegment[], time: number): boolean {
  for (const segment of segments) {
    if (time >= segment.start - EPSILON && time < segment.end) {
      return true;
    }
  }

  return false;
}

export function findNextKeptStart(segments: TrimSegment[], time: number): number | undefined {
  for (const segment of segments) {
    if (segment.end <= time) {
      continue;
    }
    if (segment.start > time) {
      return segment.start;
    }
    return time;
  }

  return undefined;
}

export function splitAt(segments: TrimSegment[], time: number): TrimSegment[] {
  if (segments.length === 0) {
    return segments;
  }

  const index = findSegmentIndexAt(segments, time);
  const segment = segments[index];

  if (time <= segment.start + EPSILON || time >= segment.end - EPSILON) {
    return segments;
  }

  const safeTime = Math.min(Math.max(time, segment.start + EPSILON), segment.end - EPSILON);

  return [
    ...segments.slice(0, index),
    { start: segment.start, end: safeTime },
    { start: safeTime, end: segment.end },
    ...segments.slice(index + 1)
  ];
}

export function removeSegment(segments: TrimSegment[], index: number): TrimSegment[] {
  if (index < 0 || index >= segments.length) {
    return segments;
  }

  if (segments.length === 1) {
    return segments;
  }

  return segments.filter((_, current) => current !== index);
}

export function joinWithNext(segments: TrimSegment[], index: number): TrimSegment[] {
  if (index < 0 || index >= segments.length - 1) {
    return segments;
  }

  const next = segments[index + 1];
  return segments.map((segment, current) =>
    current === index ? { start: segment.start, end: next.end } : segment
  ).filter((_, current) => current !== index + 1);
}

export function setSegmentStart(segments: TrimSegment[], index: number, start: number, duration: number): TrimSegment[] {
  if (index < 0 || index >= segments.length) {
    return segments;
  }

  const segment = segments[index];
  const minStart = index === 0 ? 0 : segments[index - 1].end;
  const maxStart = segment.end - EPSILON;
  const clamped = Math.min(Math.max(start, minStart), maxStart);
  if (Math.abs(clamped - segment.start) < EPSILON) {
    return segments;
  }

  return segments.map((current, currentIndex) =>
    currentIndex === index ? { start: clamped, end: Math.min(segment.end, duration) } : current
  );
}

export function setSegmentEnd(segments: TrimSegment[], index: number, end: number, duration: number): TrimSegment[] {
  if (index < 0 || index >= segments.length) {
    return segments;
  }

  const segment = segments[index];
  const minEnd = segment.start + EPSILON;
  const maxEnd = index === segments.length - 1 ? duration : segments[index + 1].start;
  const clamped = Math.max(Math.min(end, maxEnd), minEnd);
  if (Math.abs(clamped - segment.end) < EPSILON) {
    return segments;
  }

  return segments.map((current, currentIndex) =>
    currentIndex === index ? { start: segment.start, end: clamped } : current
  );
}

export function effectiveDuration(item: { metadata?: VideoMetadata; trimSegments?: TrimSegment[] }): number {
  if (item.trimSegments && item.trimSegments.length > 0) {
    return totalKeptDuration(item.trimSegments);
  }

  return Math.max(0, item.metadata?.duration ?? 0);
}
