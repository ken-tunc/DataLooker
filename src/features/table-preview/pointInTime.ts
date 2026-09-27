import { offsetAt } from "../query/cell";

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** Seconds east of UTC, or UTC's own for a zone this cannot place. */
function offsetOf(at: Date, timeZone: string): number {
  try {
    return offsetAt(at, timeZone) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * `at` on the wall clock of `timeZone`, to the second, as the grid writes a
 * point in time: `2025-01-02 10:00:00+09`. The offset stays because an hour a
 * zone's clocks go back over happens twice, and only it says which is meant.
 */
export function wallClock(at: Date, timeZone: string): string {
  const offset = offsetOf(at, timeZone);
  const wall = new Date(at.getTime() + offset * 1000);
  const magnitude = Math.abs(offset);
  const minutes = Math.floor((magnitude % 3600) / 60);
  return (
    `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())} ` +
    `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `${offset < 0 ? "-" : "+"}${pad(Math.floor(magnitude / 3600))}` +
    (minutes === 0 ? "" : `:${pad(minutes)}`)
  );
}

const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(?:(Z)|([+-])(\d{2}):?(\d{2})?)?$/i;

/**
 * What the reader typed, read on the wall clock of `timeZone` unless it names
 * its own offset. Null for anything that is not a date and a time, or names a
 * day or an hour that does not exist.
 */
export function parseWallClock(text: string, timeZone: string): Date | null {
  const parts = WALL_CLOCK.exec(text.trim());
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = "0", millis = "0", utc, sign, oh, om = "0"] =
    parts;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // Built field by field: `Date.UTC` reads a year below 100 as 19xx.
  const wall = new Date(0);
  wall.setUTCFullYear(y, mo - 1, d);
  wall.setUTCHours(h, mi, s, Number(millis.padEnd(3, "0")));
  // A 31st of February rolls over into March rather than failing.
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi ||
    wall.getUTCSeconds() !== s
  ) {
    return null;
  }

  if (utc) return wall;
  if (sign) {
    const offset = (sign === "-" ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60);
    return new Date(wall.getTime() - offset * 1000);
  }
  // The offset depends on the instant it is asked for, which is what is being
  // found: asked twice, it settles on the offset in force at that wall time.
  const first = new Date(wall.getTime() - offsetOf(wall, timeZone) * 1000);
  const at = new Date(wall.getTime() - offsetOf(first, timeZone) * 1000);
  // A time the clocks spring forward over never happens, and reading it as the
  // hour beside it would read a point the reader did not write.
  return at.getTime() + offsetOf(at, timeZone) * 1000 === wall.getTime() ? at : null;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  const utc = (iso: string) => new Date(iso);

  describe("wallClock", () => {
    it("reads a point on the zone's wall clock", () => {
      expect(wallClock(utc("2025-01-02T01:00:00.900Z"), "Asia/Tokyo")).toBe(
        "2025-01-02 10:00:00+09",
      );
      expect(wallClock(utc("2025-07-01T12:00:00Z"), "America/New_York")).toBe(
        "2025-07-01 08:00:00-04",
      );
      expect(wallClock(utc("2025-01-02T01:00:00Z"), "Asia/Kolkata")).toBe(
        "2025-01-02 06:30:00+05:30",
      );
    });

    it("names which of the two times an hour the clocks go back over it is", () => {
      // New York's 01:30 on 2 November 2025 happens first at -04, then at -05.
      for (const iso of ["2025-11-02T05:30:00.000Z", "2025-11-02T06:30:00.000Z"]) {
        const written = wallClock(utc(iso), "America/New_York");
        expect(parseWallClock(written, "America/New_York")?.toISOString()).toBe(iso);
      }
    });

    it("falls back to UTC for a zone that does not exist", () => {
      expect(wallClock(utc("2025-01-02T01:00:00Z"), "Mars/Olympus")).toBe("2025-01-02 01:00:00+00");
    });
  });

  describe("parseWallClock", () => {
    it("reads a wall time in the zone, whichever offset is in force then", () => {
      expect(parseWallClock("2025-01-02 10:00:00", "Asia/Tokyo")).toEqual(
        utc("2025-01-02T01:00:00Z"),
      );
      expect(parseWallClock("2025-01-15 08:00", "America/New_York")).toEqual(
        utc("2025-01-15T13:00:00Z"),
      );
      expect(parseWallClock("2025-07-15T08:00:00.25", "America/New_York")).toEqual(
        utc("2025-07-15T12:00:00.250Z"),
      );
    });

    it("keeps an offset the text names over the zone's", () => {
      expect(parseWallClock("2025-01-02 10:00:00+09", "UTC")).toEqual(utc("2025-01-02T01:00:00Z"));
      expect(parseWallClock("2025-01-02 10:00:00 -05:30", "Asia/Tokyo")).toEqual(
        utc("2025-01-02T15:30:00Z"),
      );
      expect(parseWallClock("2025-01-02T01:00:00Z", "Asia/Tokyo")).toEqual(
        utc("2025-01-02T01:00:00Z"),
      );
    });

    it("refuses what is not a date and a time", () => {
      for (const text of ["", "yesterday", "2025-01-02", "2025-02-30 10:00", "2025-01-02 25:00"]) {
        expect(parseWallClock(text, "UTC"), text).toBeNull();
      }
    });

    it("refuses a time the zone's clocks spring forward over", () => {
      // New York went from 02:00 straight to 03:00 on 9 March 2025.
      expect(parseWallClock("2025-03-09 02:30", "America/New_York")).toBeNull();
      expect(parseWallClock("2025-03-09 03:30", "America/New_York")).toEqual(
        utc("2025-03-09T07:30:00Z"),
      );
    });
  });
}
