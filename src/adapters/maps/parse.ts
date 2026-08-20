import { PlaceError } from "../../core/errors.js";
import {
  assertValidHours,
  intervalWrapsMidnight,
} from "../../core/hours.js";
import { extractLatLng, isUsOrUkLatLng, placeIdFromCanonical } from "../../core/place.js";
import type {
  CountryCode,
  Hours,
  HoursInterval,
  Place,
  PlaceAddress,
  Review,
  SearchHit,
  Weekday,
} from "../../types.js";

const GOOGLE_PLACE_ID_RE = /^(ChIJ|GhIJ|EhIJ|WhIJ)[A-Za-z0-9_-]+$/;

export type GoogleText = {
  text?: unknown;
  languageCode?: unknown;
};

export type GoogleLatLng = {
  latitude?: unknown;
  longitude?: unknown;
};

export type GoogleAddressComponent = {
  longText?: unknown;
  shortText?: unknown;
  types?: unknown;
};

export type GooglePeriodEndpoint = {
  day?: unknown;
  hour?: unknown;
  minute?: unknown;
};

export type GoogleOpeningHours = {
  periods?: unknown;
  weekdayDescriptions?: unknown;
};

export type GoogleReview = {
  name?: unknown;
  rating?: unknown;
  text?: unknown;
  originalText?: unknown;
  publishTime?: unknown;
  authorAttribution?: unknown;
};

export type GooglePlace = {
  id?: unknown;
  displayName?: unknown;
  formattedAddress?: unknown;
  addressComponents?: unknown;
  location?: unknown;
  nationalPhoneNumber?: unknown;
  websiteUri?: unknown;
  rating?: unknown;
  userRatingCount?: unknown;
  regularOpeningHours?: unknown;
  types?: unknown;
  googleMapsUri?: unknown;
  reviews?: unknown;
  timeZone?: unknown;
};

export type GoogleSearchResponse = {
  places?: unknown;
};

export function extractGooglePlaceId(url: URL): string | null {
  for (const key of ["place_id", "placeid", "query_place_id"]) {
    const value = url.searchParams.get(key);
    if (value !== null && isGooglePlaceId(value)) {
      return value;
    }
  }
  const q = url.searchParams.get("q");
  if (q !== null) {
    const fromQ = q.match(/place_id:([A-Za-z0-9_-]+)/i);
    if (fromQ?.[1] !== undefined && isGooglePlaceId(fromQ[1])) {
      return fromQ[1];
    }
  }
  const blob = `${url.pathname}${url.search}${url.hash}`;
  const fromData = blob.match(/!1s((?:ChIJ|GhIJ|EhIJ|WhIJ)[A-Za-z0-9_-]+)/);
  if (fromData?.[1] !== undefined) {
    return fromData[1];
  }
  return null;
}

export function isGooglePlaceId(value: string): boolean {
  return GOOGLE_PLACE_ID_RE.test(value);
}

export function textQueryFromMapsUrl(url: URL): string | null {
  const slug = url.pathname.match(/\/maps\/place\/([^/]+)/i);
  if (slug?.[1] === undefined) {
    return null;
  }
  const name = decodeURIComponent(slug[1].replace(/\+/g, " ")).trim();
  return name === "" ? null : name;
}

export function countryFromAddressComponents(
  components: readonly GoogleAddressComponent[] | undefined,
): CountryCode | null {
  if (components === undefined) {
    return null;
  }
  for (const row of components) {
    if (!Array.isArray(row.types) || !row.types.includes("country")) {
      continue;
    }
    const short = typeof row.shortText === "string" ? row.shortText.toUpperCase() : "";
    if (short === "US" || short === "GB" || short === "UK") {
      return short === "UK" ? "GB" : short;
    }
    return null;
  }
  return null;
}

export function addressFromGooglePlace(raw: GooglePlace, country: CountryCode): PlaceAddress {
  const components = Array.isArray(raw.addressComponents)
    ? (raw.addressComponents as GoogleAddressComponent[])
    : [];
  const formatted =
    typeof raw.formattedAddress === "string" ? raw.formattedAddress.trim() : "";
  const streetNumber = componentText(components, "street_number");
  const route = componentText(components, "route");
  const line1 = [streetNumber, route].filter((part) => part !== null).join(" ");
  return {
    line1: line1 === "" ? null : line1,
    city:
      componentText(components, "locality") ??
      componentText(components, "postal_town") ??
      componentText(components, "sublocality"),
    region:
      componentShort(components, "administrative_area_level_1") ??
      componentText(components, "administrative_area_level_1"),
    postal: componentText(components, "postal_code"),
    country,
    formatted,
  };
}

export function hoursFromGooglePlace(raw: GooglePlace): Hours | null {
  const opening = asRecord(raw.regularOpeningHours);
  if (opening === null || !Array.isArray(opening.periods)) {
    return null;
  }
  const weekly: HoursInterval[] = [];
  for (const period of opening.periods) {
    weekly.push(...intervalsFromPeriod(period));
  }
  if (weekly.length === 0) {
    return null;
  }
  const tzRaw = asRecord(raw.timeZone);
  const timezone =
    tzRaw !== null && typeof tzRaw.id === "string" && tzRaw.id.trim() !== ""
      ? tzRaw.id.trim()
      : null;
  const note = weekdayNote(opening.weekdayDescriptions);
  const hours: Hours = { timezone, weekly, note };
  try {
    assertValidHours(hours);
  } catch {
    return null;
  }
  return hours;
}

export function reviewsFromGooglePlace(raw: GooglePlace): Review[] {
  if (!Array.isArray(raw.reviews)) {
    return [];
  }
  const out: Review[] = [];
  for (const row of raw.reviews) {
    const review = reviewFromGoogle(row);
    if (review !== null) {
      out.push(review);
    }
  }
  return out;
}

export function placeFromGooglePlace(
  raw: GooglePlace,
  mapsUrl: string,
  now: Date,
): Place {
  const name = displayName(raw);
  const formatted =
    typeof raw.formattedAddress === "string" ? raw.formattedAddress.trim() : "";
  if (name === null || formatted === "") {
    throw new PlaceError("place_not_found", "Place not found.");
  }
  const country = resolveCountry(raw);
  if (country === null) {
    throw new PlaceError(
      "region_unsupported",
      "This place is outside United States and United Kingdom coverage.",
    );
  }
  const location = latLngFromGoogle(raw.location);
  return {
    id: placeIdFromCanonical(mapsUrl),
    name,
    address: addressFromGooglePlace(raw, country),
    location,
    phone: stringOrNull(raw.nationalPhoneNumber),
    website: stringOrNull(raw.websiteUri),
    rating: {
      average: typeof raw.rating === "number" && Number.isFinite(raw.rating) ? raw.rating : null,
      count:
        typeof raw.userRatingCount === "number" && Number.isInteger(raw.userRatingCount)
          ? raw.userRatingCount
          : null,
    },
    hours: hoursFromGooglePlace(raw),
    categories: categoriesFromTypes(raw.types),
    mapsUrl,
    fetchedAt: now.toISOString(),
  };
}

export function searchHitFromGooglePlace(raw: GooglePlace): SearchHit | null {
  const mapsUrl = typeof raw.googleMapsUri === "string" ? raw.googleMapsUri.trim() : "";
  if (mapsUrl === "") {
    return null;
  }
  const name = displayName(raw);
  const formatted =
    typeof raw.formattedAddress === "string" ? raw.formattedAddress.trim() : "";
  if (name === null || formatted === "") {
    return null;
  }
  const country = resolveCountry(raw);
  if (country === null) {
    return null;
  }
  return {
    id: placeIdFromCanonical(mapsUrl),
    name,
    address: addressFromGooglePlace(raw, country),
    location: latLngFromGoogle(raw.location),
    rating: {
      average: typeof raw.rating === "number" && Number.isFinite(raw.rating) ? raw.rating : null,
      count:
        typeof raw.userRatingCount === "number" && Number.isInteger(raw.userRatingCount)
          ? raw.userRatingCount
          : null,
    },
    categories: categoriesFromTypes(raw.types),
    mapsUrl,
  };
}

export type ParsedSearchHit = {
  hit: SearchHit;
  vendorPlaceId: string | null;
  raw: GooglePlace;
};

export function parseSearchResponse(body: unknown): ParsedSearchHit[] {
  if (body === null || typeof body !== "object") {
    return [];
  }
  const places = (body as GoogleSearchResponse).places;
  if (!Array.isArray(places)) {
    return [];
  }
  const hits: ParsedSearchHit[] = [];
  for (const row of places) {
    if (row === null || typeof row !== "object") {
      continue;
    }
    const raw = row as GooglePlace;
    const hit = searchHitFromGooglePlace(raw);
    if (hit !== null) {
      hits.push({ hit, vendorPlaceId: vendorPlaceIdOf(raw), raw });
    }
  }
  return hits;
}

export function vendorPlaceIdOf(raw: GooglePlace): string | null {
  if (typeof raw.id === "string" && isGooglePlaceId(raw.id)) {
    return raw.id;
  }
  return null;
}

function resolveCountry(raw: GooglePlace): CountryCode | null {
  const components = Array.isArray(raw.addressComponents)
    ? (raw.addressComponents as GoogleAddressComponent[])
    : undefined;
  const fromComponents = countryFromAddressComponents(components);
  if (fromComponents !== null) {
    return fromComponents;
  }
  const location = latLngFromGoogle(raw.location);
  if (location !== null) {
    return isUsOrUkLatLng(location.lat, location.lng) ? countryFromLatLng(location) : null;
  }
  return null;
}

function countryFromLatLng(location: { lat: number; lng: number }): CountryCode {
  if (location.lng > -20 && location.lat > 49) {
    return "GB";
  }
  return "US";
}

function displayName(raw: GooglePlace): string | null {
  if (typeof raw.displayName === "string" && raw.displayName.trim() !== "") {
    return raw.displayName.trim();
  }
  const named = asRecord(raw.displayName);
  if (named !== null && typeof named.text === "string" && named.text.trim() !== "") {
    return named.text.trim();
  }
  return null;
}

function latLngFromGoogle(value: unknown): { lat: number; lng: number } | null {
  const loc = asRecord(value);
  if (loc === null) {
    return null;
  }
  const lat = loc.latitude;
  const lng = loc.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function reviewFromGoogle(raw: unknown): Review | null {
  const row = asRecord(raw);
  if (row === null) {
    return null;
  }
  if (!Number.isInteger(row.rating) || (row.rating as number) < 1 || (row.rating as number) > 5) {
    return null;
  }
  const text = reviewText(row);
  if (text === null) {
    return null;
  }
  const authorObj = asRecord(row.authorAttribution);
  const author =
    authorObj !== null && typeof authorObj.displayName === "string"
      ? authorObj.displayName
      : null;
  const textObj = asRecord(row.text) ?? asRecord(row.originalText);
  return {
    id: reviewId(row.name),
    author,
    stars: row.rating as number,
    text,
    createdAt: typeof row.publishTime === "string" ? row.publishTime : null,
    language:
      textObj !== null && typeof textObj.languageCode === "string"
        ? textObj.languageCode
        : null,
  };
}

function reviewText(row: Record<string, unknown>): string | null {
  for (const key of ["text", "originalText"] as const) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    const obj = asRecord(value);
    if (obj !== null && typeof obj.text === "string" && obj.text.trim() !== "") {
      return obj.text.trim();
    }
  }
  return null;
}

function reviewId(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return null;
  }
  const parts = name.split("/").filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  return last === undefined || last === "" ? null : last;
}

function intervalsFromPeriod(raw: unknown): HoursInterval[] {
  const period = asRecord(raw);
  if (period === null) {
    return [];
  }
  const open = endpoint(period.open);
  if (open === null) {
    return [];
  }
  const close = endpoint(period.close);
  if (close === null) {
    if (open.hour === 0 && open.minute === 0) {
      return [{ day: open.day, open: "00:00", close: "24:00" }];
    }
    return [];
  }
  if (open.day === close.day) {
    const interval = {
      day: open.day,
      open: hhmm(open.hour, open.minute),
      close: hhmm(close.hour, close.minute),
    };
    if (intervalWrapsMidnight(interval.open, interval.close)) {
      return [];
    }
    return [interval];
  }
  if (close.hour === 0 && close.minute === 0 && nextDay(open.day) === close.day) {
    return [{ day: open.day, open: hhmm(open.hour, open.minute), close: "24:00" }];
  }
  return [
    { day: open.day, open: hhmm(open.hour, open.minute), close: "24:00" },
    { day: close.day, open: "00:00", close: hhmm(close.hour, close.minute) },
  ].filter((row) => !intervalWrapsMidnight(row.open, row.close));
}

function endpoint(raw: unknown): { day: Weekday; hour: number; minute: number } | null {
  const row = asRecord(raw);
  if (row === null) {
    return null;
  }
  if (!Number.isInteger(row.day) || (row.day as number) < 0 || (row.day as number) > 6) {
    return null;
  }
  const hour = row.hour === undefined ? 0 : row.hour;
  const minute = row.minute === undefined ? 0 : row.minute;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) {
    return null;
  }
  if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
    return null;
  }
  return { day: row.day as Weekday, hour: hour as number, minute: minute as number };
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function nextDay(day: Weekday): Weekday {
  return ((day + 1) % 7) as Weekday;
}

function weekdayNote(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines = value.filter((row): row is string => typeof row === "string" && row.trim() !== "");
  return lines.length === 0 ? null : lines.join(" ");
}

function categoriesFromTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((row): row is string => typeof row === "string" && row.trim() !== "");
}

function componentText(
  components: readonly GoogleAddressComponent[],
  type: string,
): string | null {
  for (const row of components) {
    if (!Array.isArray(row.types) || !row.types.includes(type)) {
      continue;
    }
    if (typeof row.longText === "string" && row.longText.trim() !== "") {
      return row.longText;
    }
    if (typeof row.shortText === "string" && row.shortText.trim() !== "") {
      return row.shortText;
    }
  }
  return null;
}

function componentShort(
  components: readonly GoogleAddressComponent[],
  type: string,
): string | null {
  for (const row of components) {
    if (!Array.isArray(row.types) || !row.types.includes(type)) {
      continue;
    }
    if (typeof row.shortText === "string" && row.shortText.trim() !== "") {
      return row.shortText;
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function rejectIfOutsideCoverage(url: URL): void {
  const coords = extractLatLng(url);
  if (coords !== null && !isUsOrUkLatLng(coords.lat, coords.lng)) {
    throw new PlaceError(
      "region_unsupported",
      "This place is outside United States and United Kingdom coverage.",
    );
  }
}
