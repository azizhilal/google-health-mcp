/**
 * Pure date helpers shared by the API client and the tools layer. Kept free of
 * I/O so they can be unit-tested — these are exactly the spots that bit us:
 * the CivilDateTime `date` wrapper, inclusive→exclusive end conversion, and
 * timezone-correct "today".
 */

/** A calendar date (google.type.Date); wrapped in a CivilDateTime's `date`
 *  field by callers. No time component = midnight = whole day. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Parse a "YYYY-MM-DD" string into the API's google.type.Date shape. */
export function toCivilDate(isoDate: string): CivilDate {
  const [year, month, day] = isoDate.split("-").map((n) => parseInt(n, 10));
  if (!year || !month || !day) {
    throw new Error(`Invalid date "${isoDate}" — expected YYYY-MM-DD`);
  }
  return { year, month, day };
}

/** The day after `isoDate` ("YYYY-MM-DD"), used to turn an inclusive end into
 *  the exclusive upper bound the API's range/filter expects. */
export function nextDayIso(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" for an instant, as seen in the given IANA timezone. */
export function isoInTz(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD; the timeZone option shifts the calendar day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "YYYY-MM-DD" for today, in the given timezone. */
export function todayIso(timeZone: string, now: Date = new Date()): string {
  return isoInTz(now, timeZone);
}

/** "YYYY-MM-DD" for a date N days before today, in the given timezone. */
export function isoDaysAgo(days: number, timeZone: string, now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return isoInTz(d, timeZone);
}
