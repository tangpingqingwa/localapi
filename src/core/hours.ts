import type { Hours, HoursInterval, Weekday } from "../types.js";
import { getPlaceFixtureById } from "./place.js";

const OPEN_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CLOSE_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

type HoursSeed = Hours | null;

function everyday(open: string, close: string): HoursInterval[] {
  return ([0, 1, 2, 3, 4, 5, 6] as const).map((day) => ({ day, open, close }));
}

function except(open: string, close: string, closed: readonly Weekday[]): HoursInterval[] {
  const skip = new Set<Weekday>(closed);
  return ([0, 1, 2, 3, 4, 5, 6] as const)
    .filter((day) => !skip.has(day))
    .map((day) => ({ day, open, close }));
}

function hours(timezone: string, weekly: HoursInterval[], note: string | null = null): Hours {
  const value: Hours = { timezone, weekly, note };
  assertValidHours(value);
  return value;
}

const HOURS_BY_SLUG: Record<string, HoursSeed> = {
  "franklin-bbq-austin": hours(
    "America/Chicago",
    except("11:00", "15:00", [1]),
    "Closed Monday. Closes when sold out.",
  ),
  "la-barbecue-austin": hours("America/Chicago", except("11:00", "16:00", [1])),
  "torchys-tacos-south-congress": hours("America/Chicago", everyday("10:00", "22:00")),
  "home-slice-pizza-austin": hours("America/Chicago", everyday("11:00", "23:00")),
  "bookpeople-austin": hours("America/Chicago", everyday("09:00", "21:00")),
  "katzs-delicatessen-nyc": hours("America/New_York", everyday("00:00", "24:00")),
  "joe-coffee-west-village": hours("America/New_York", everyday("07:00", "18:00")),
  "levain-bakery-w74": hours("America/New_York", everyday("08:00", "19:00")),
  "strand-bookstore-nyc": hours("America/New_York", everyday("10:00", "20:00")),
  "russ-and-daughters-nyc": hours("America/New_York", everyday("08:00", "18:00")),
  "tartine-bakery-sf": hours("America/Los_Angeles", everyday("08:00", "17:00")),
  "bi-rite-market-sf": hours("America/Los_Angeles", everyday("08:00", "21:00")),
  "city-lights-bookstore-sf": hours("America/Los_Angeles", everyday("10:00", "22:00")),
  "blue-bottle-mint-sf": null,
  "pike-place-chowder-seattle": hours("America/Los_Angeles", everyday("11:00", "17:00")),
  "elliott-bay-book-seattle": hours("America/Los_Angeles", everyday("10:00", "20:00")),
  "pats-king-of-steaks-philly": hours("America/New_York", everyday("00:00", "24:00")),
  "reading-terminal-market-philly": hours(
    "America/New_York",
    except("08:00", "18:00", [0]),
    "Closed Sunday.",
  ),
  "portillos-clark-chicago": hours("America/Chicago", everyday("10:00", "23:00")),
  "lou-malnatis-river-north": hours("America/Chicago", everyday("11:00", "23:00")),
  "dishoom-covent-garden": hours("Europe/London", everyday("08:00", "23:00")),
  "borough-market-london": hours(
    "Europe/London",
    except("10:00", "17:00", [0]),
    "Individual stall hours vary.",
  ),
  "monmouth-coffee-borough": hours("Europe/London", except("07:30", "18:00", [0])),
  "neals-yard-dairy-london": hours("Europe/London", except("10:00", "18:00", [0])),
  "fortnum-and-mason-piccadilly": hours("Europe/London", everyday("10:00", "20:00")),
  "daunt-books-marylebone": hours("Europe/London", everyday("09:00", "19:00")),
  "the-ivy-west-street": hours("Europe/London", everyday("12:00", "23:30")),
  "brewdog-soho": hours("Europe/London", [
    { day: 0, open: "00:00", close: "01:00" },
    { day: 0, open: "12:00", close: "22:30" },
    { day: 1, open: "12:00", close: "23:00" },
    { day: 2, open: "12:00", close: "23:00" },
    { day: 3, open: "12:00", close: "23:00" },
    { day: 4, open: "12:00", close: "23:00" },
    { day: 5, open: "12:00", close: "24:00" },
    { day: 6, open: "00:00", close: "01:00" },
    { day: 6, open: "12:00", close: "24:00" },
  ]),
  "waterstones-piccadilly": hours("Europe/London", everyday("09:00", "22:00")),
  "gaucho-piccadilly": hours("Europe/London", everyday("12:00", "23:00")),
};

function minutesFromHhMm(value: string): number {
  if (value === "24:00") {
    return 24 * 60;
  }
  const [hoursPart, minutesPart] = value.split(":");
  return Number(hoursPart) * 60 + Number(minutesPart);
}

function isValidOpenTime(value: string): boolean {
  return OPEN_RE.test(value);
}

function isValidCloseTime(value: string): boolean {
  return CLOSE_RE.test(value);
}

/** True when a single interval would wrap past midnight (forbidden). */
export function intervalWrapsMidnight(open: string, close: string): boolean {
  if (!isValidOpenTime(open) || !isValidCloseTime(close)) {
    return true;
  }
  return minutesFromHhMm(close) <= minutesFromHhMm(open);
}

export function assertValidHours(value: Hours): void {
  if (value.timezone !== null && value.timezone.trim() === "") {
    throw new Error("hours.timezone must be null or a non-empty IANA name");
  }
  if (value.note !== null && typeof value.note !== "string") {
    throw new Error("hours.note must be string or null");
  }
  for (const row of value.weekly) {
    if (!Number.isInteger(row.day) || row.day < 0 || row.day > 6) {
      throw new Error(`hours day must be 0-6, got ${String(row.day)}`);
    }
    if (!isValidOpenTime(row.open)) {
      throw new Error(`invalid open time ${row.open}`);
    }
    if (!isValidCloseTime(row.close)) {
      throw new Error(`invalid close time ${row.close}`);
    }
    if (intervalWrapsMidnight(row.open, row.close)) {
      throw new Error(
        `interval ${row.open}-${row.close} wraps past 24:00; split into two intervals`,
      );
    }
  }
}

export function cloneHours(value: Hours | null): Hours | null {
  if (value === null) {
    return null;
  }
  return {
    timezone: value.timezone,
    weekly: value.weekly.map((row) => ({ day: row.day, open: row.open, close: row.close })),
    note: value.note,
  };
}

export function listHoursSlugs(): string[] {
  return Object.keys(HOURS_BY_SLUG);
}

export function getHoursBySlug(slug: string): Hours | null {
  if (!(slug in HOURS_BY_SLUG)) {
    return null;
  }
  return cloneHours(HOURS_BY_SLUG[slug] ?? null);
}

export function getHoursByPlaceId(id: string): Hours | null {
  return getHoursBySlug(getPlaceFixtureById(id).slug);
}
