import { describe, it, expect } from "vitest";
import { toCivilDate, nextDayIso, isoInTz, todayIso, isoDaysAgo } from "./dates";

describe("toCivilDate", () => {
  it("parses a YYYY-MM-DD string into google.type.Date parts", () => {
    expect(toCivilDate("2026-06-11")).toEqual({ year: 2026, month: 6, day: 11 });
  });

  it("throws on malformed input", () => {
    expect(() => toCivilDate("2026/06/11")).toThrow();
    expect(() => toCivilDate("not-a-date")).toThrow();
  });
});

describe("nextDayIso (inclusive end -> exclusive bound)", () => {
  it("advances one day", () => {
    expect(nextDayIso("2026-06-11")).toBe("2026-06-12");
  });

  it("rolls over a month boundary", () => {
    expect(nextDayIso("2026-06-30")).toBe("2026-07-01");
  });

  it("rolls over a year boundary", () => {
    expect(nextDayIso("2026-12-31")).toBe("2027-01-01");
  });

  it("handles a leap day", () => {
    expect(nextDayIso("2028-02-28")).toBe("2028-02-29");
  });
});

describe("isoInTz (the UTC-midnight bug class)", () => {
  // 23:30Z is already the next calendar day in London (summer = UTC+1),
  // still the same day in UTC, and the same day in New York (UTC-4).
  const instant = new Date("2026-06-11T23:30:00Z");

  it("formats per timezone, not per UTC", () => {
    expect(isoInTz(instant, "UTC")).toBe("2026-06-11");
    expect(isoInTz(instant, "Europe/London")).toBe("2026-06-12");
    expect(isoInTz(instant, "America/New_York")).toBe("2026-06-11");
  });
});

describe("todayIso / isoDaysAgo (with injected now)", () => {
  const now = new Date("2026-06-11T10:00:00Z");

  it("todayIso returns the local calendar day", () => {
    expect(todayIso("Europe/London", now)).toBe("2026-06-11");
  });

  it("isoDaysAgo subtracts whole days", () => {
    expect(isoDaysAgo(7, "Europe/London", now)).toBe("2026-06-04");
    expect(isoDaysAgo(0, "Europe/London", now)).toBe("2026-06-11");
  });
});
