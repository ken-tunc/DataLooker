/** A cell is JSON, so it can be anything. */
export function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * A cell as its full view shows it: a document or an array indented, since
 * that is where one runs long. A string is left alone even if it reads as
 * JSON, because parsing it would round the numbers it spells out.
 */
export function formatCellInFull(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
  return formatCell(value);
}

/**
 * A point in time as both drivers send it, in UTC and in the notation of
 * Rust's `time`: `2025-01-02 1:00:00.5 +00:00:00`, the hour unpadded.
 */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))? ([+-])(\d{2}):(\d{2}):(\d{2})$/;

/** `GMT`, `GMT+09:00`, or with seconds for a zone's local mean time. */
const OFFSET = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** Seconds east of UTC in `timeZone` at `at`. Throws for a zone that does not exist. */
function offsetAt(at: Date, timeZone: string): number | null {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormats.set(timeZone, format);
  }
  const name = format.formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  const parts = OFFSET.exec(name ?? "");
  if (!parts) return null;
  const [, sign, hours = "0", minutes = "0", seconds = "0"] = parts;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * A point in time as it reads in `timeZone`, written as PostgreSQL writes one:
 * `2025-01-02 10:00:00.5+09`. The offset stays, so the text still names the
 * same instant when it is copied or edited and cast back. Anything else, an
 * array's elements aside, is left as it came, and so is a point this cannot
 * place: a zone that does not exist, or a year outside 1 to 9999.
 */
export function inTimeZone(value: unknown, timeZone: string): unknown {
  if (Array.isArray(value)) return value.map((item) => inTimeZone(item, timeZone));
  if (typeof value !== "string") return value;
  const parts = INSTANT.exec(value);
  if (!parts) return value;
  const [, year, month, day, hour, minute, second, fraction = "", sign, oh, om, os] = parts;
  const sentOffset = (sign === "-" ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os));

  // Built field by field: `Date.UTC` reads a year below 100 as 19xx.
  const at = new Date(0);
  at.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  at.setUTCHours(Number(hour), Number(minute), Number(second) - sentOffset);

  let offset: number | null;
  try {
    offset = offsetAt(at, timeZone);
  } catch {
    return value;
  }
  if (offset === null) return value;
  // The wall clock in the zone, read off a date moved by its offset.
  const wall = new Date(at.getTime() + offset * 1000);
  const wallYear = wall.getUTCFullYear();
  if (Number.isNaN(wallYear) || wallYear < 1 || wallYear > 9999) return value;

  // The offset is whole seconds, so the fraction is the one that was sent.
  const digits = fraction.replace(/0+$/, "");
  const magnitude = Math.abs(offset);
  const offsetText =
    (offset < 0 ? "-" : "+") +
    pad(Math.floor(magnitude / 3600)) +
    (magnitude % 3600 === 0 ? "" : `:${pad(Math.floor((magnitude % 3600) / 60))}`) +
    (magnitude % 60 === 0 ? "" : `:${pad(magnitude % 60)}`);
  return (
    `${pad(wallYear, 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())} ` +
    `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    (digits === "" ? "" : `.${digits}`) +
    offsetText
  );
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("formatCell", () => {
    it("shows NULL for a missing value", () => {
      expect(formatCell(null)).toBe("NULL");
    });

    it("leaves a string as it is, so a quoted one is not quoted twice", () => {
      expect(formatCell('say "hi"')).toBe('say "hi"');
      expect(formatCell("")).toBe("");
    });

    it("writes documents and arrays back as JSON", () => {
      expect(formatCell({ a: 1 })).toBe('{"a":1}');
      expect(formatCell([1, null, 3])).toBe("[1,null,3]");
    });

    it("prints numbers and booleans as they read in SQL", () => {
      expect(formatCell(42)).toBe("42");
      expect(formatCell(1.5)).toBe("1.5");
      expect(formatCell(true)).toBe("true");
    });
  });

  describe("formatCellInFull", () => {
    it("indents a document so that its nesting shows", () => {
      expect(formatCellInFull({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
    });

    it("leaves a string that reads as JSON as it came", () => {
      expect(formatCellInFull('{"id": 12345678901234567890}')).toBe('{"id": 12345678901234567890}');
    });
  });

  describe("inTimeZone", () => {
    const sent = "2025-01-02 10:00:00.123456 +00:00:00";

    it("writes a point in UTC the way PostgreSQL does", () => {
      expect(inTimeZone("2025-01-02 1:00:00.0 +00:00:00", "UTC")).toBe("2025-01-02 01:00:00+00");
      expect(inTimeZone(sent, "UTC")).toBe("2025-01-02 10:00:00.123456+00");
    });

    it("moves a point into the zone and says which offset it took", () => {
      expect(inTimeZone(sent, "Asia/Tokyo")).toBe("2025-01-02 19:00:00.123456+09");
      expect(inTimeZone(sent, "Asia/Kolkata")).toBe("2025-01-02 15:30:00.123456+05:30");
      expect(inTimeZone("2025-12-31 20:00:00.0 +00:00:00", "Asia/Tokyo")).toBe(
        "2026-01-01 05:00:00+09",
      );
    });

    it("takes the offset in force at that point, not now", () => {
      expect(inTimeZone(sent, "America/New_York")).toBe("2025-01-02 05:00:00.123456-05");
      expect(inTimeZone("2025-07-01 12:00:00.0 +00:00:00", "America/New_York")).toBe(
        "2025-07-01 08:00:00-04",
      );
      // Before standard time, a zone kept its city's own clock.
      expect(inTimeZone("1880-01-01 0:00:00.0 +00:00:00", "Asia/Tokyo")).toBe(
        "1880-01-01 09:18:59+09:18:59",
      );
    });

    it("reads the offset a point was sent with", () => {
      expect(inTimeZone("2025-01-02 19:00:00.0 +09:00:00", "UTC")).toBe("2025-01-02 10:00:00+00");
    });

    it("keeps an early year as it is", () => {
      expect(inTimeZone("0050-03-01 0:00:00.0 +00:00:00", "UTC")).toBe("0050-03-01 00:00:00+00");
    });

    it("moves each element of an array", () => {
      expect(inTimeZone([sent, null], "Asia/Tokyo")).toEqual([
        "2025-01-02 19:00:00.123456+09",
        null,
      ]);
    });

    it("leaves what is not a point, or cannot be placed, as it came", () => {
      for (const value of [null, 42, "soon", "<decode error: out of range>"]) {
        expect(inTimeZone(value, "Asia/Tokyo")).toBe(value);
      }
      expect(inTimeZone(sent, "Mars/Olympus_Mons")).toBe(sent);
    });
  });
}
