/**
 * BigQuery's on-demand rate in its US and EU multi-regions. An estimate, not a
 * bill: other regions, editions and reservations each price a byte their own
 * way, and the first tebibyte of a month is free.
 */
export const DOLLARS_PER_TIB = 6.25;

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Binary units, since the rate is per tebibyte. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatCost(bytes: number): string {
  const dollars = (bytes / 1024 ** 4) * DOLLARS_PER_TIB;
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return "< $0.01";
  return `$${dollars.toFixed(2)}`;
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("formatBytes", () => {
    it("counts in powers of two", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(1023)).toBe("1023 B");
      expect(formatBytes(1536)).toBe("1.5 KiB");
      expect(formatBytes(150 * 1024 ** 3)).toBe("150 GiB");
      expect(formatBytes(2 * 1024 ** 5)).toBe("2.0 PiB");
    });
  });

  describe("formatCost", () => {
    it("prices a tebibyte at the on-demand rate", () => {
      expect(formatCost(1024 ** 4)).toBe("$6.25");
      expect(formatCost(0)).toBe("$0");
      expect(formatCost(1024)).toBe("< $0.01");
    });
  });
}
