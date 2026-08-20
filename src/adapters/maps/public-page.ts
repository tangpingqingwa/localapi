import { PlaceError } from "../../core/errors.js";
import { extractPlaceSlug } from "../../core/place.js";
import {
  isGooglePlaceId,
  placeFromGooglePlace,
  searchHitFromGooglePlace,
  vendorPlaceIdOf,
  type GooglePlace,
  type ParsedSearchHit,
} from "./parse.js";
import type { Place } from "../../types.js";

/** Public Maps listing JSON (`tbm=map`) anti-XSSI prefix. */
export const MAPS_JSON_XSSI_PREFIX = ")]}'";

const TBM_MAP_ORIGIN = "https://www.google.com";

export type PublicMapsPlaceRow = {
  google: GooglePlace;
  mapsUrl: string | null;
};

export function looksLikeBotWall(body: string): boolean {
  const sample = body.slice(0, 12_000).toLowerCase();
  if (sample.includes("unusual traffic") && sample.includes("verify you are a human")) {
    return true;
  }
  if (sample.includes("our systems have detected unusual traffic")) {
    return true;
  }
  if (sample.includes("captcha") && (sample.includes("recaptcha") || sample.includes("sorry"))) {
    return true;
  }
  if (sample.includes("enable javascript and cookies") && sample.includes("unusual traffic")) {
    return true;
  }
  return false;
}

export function stripMapsXssi(body: string): string {
  const trimmed = body.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith(MAPS_JSON_XSSI_PREFIX)) {
    return trimmed.slice(MAPS_JSON_XSSI_PREFIX.length).trimStart();
  }
  return trimmed;
}

export function parsePublicMapsJson(body: string): unknown {
  const stripped = stripMapsXssi(body);
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
}

function stringAt(row: readonly unknown[], index: number): string | null {
  const value = row[index];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  }
}

function looksLikePlaceRow(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length < 12) {
    return false;
  }
  const name = stringAt(value, 11);
  const formatted = stringAt(value, 18) ?? stringAt(value, 39);
  if (name === null || formatted === null) {
    return false;
  }
  if (name.toLowerCase() === "google maps") {
    return false;
  }
  return true;
}

function walkPlaceRows(value: unknown, out: unknown[][], seen: Set<unknown>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (looksLikePlaceRow(value)) {
    out.push(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkPlaceRows(item, out, seen);
    }
    return;
  }
  for (const item of Object.values(value)) {
    walkPlaceRows(item, out, seen);
  }
}

export function extractPublicMapsPlaceRows(payload: unknown): unknown[][] {
  const rows: unknown[][] = [];
  walkPlaceRows(payload, rows, new Set());
  return rows;
}

function latLngFromRow(row: readonly unknown[]): { latitude: number; longitude: number } | undefined {
  const loc = row[9];
  if (!Array.isArray(loc)) {
    return undefined;
  }
  const lat = loc[2];
  const lng = loc[3];
  if (typeof lat !== "number" || typeof lng !== "number") {
    return undefined;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }
  return { latitude: lat, longitude: lng };
}

function countryFromRow(row: readonly unknown[]): string | null {
  const direct = stringAt(row, 243);
  if (direct === "US" || direct === "GB" || direct === "UK") {
    return direct === "UK" ? "GB" : direct;
  }
  const parts = row[183];
  if (Array.isArray(parts)) {
    const strings: string[] = [];
    collectStrings(parts, strings);
    for (const item of strings) {
      const upper = item.toUpperCase();
      if (upper === "US" || upper === "GB" || upper === "UK") {
        return upper === "UK" ? "GB" : upper;
      }
    }
  }
  const formatted = stringAt(row, 18) ?? stringAt(row, 39) ?? "";
  if (/\bUSA\b|\bUnited States\b|, TX\b|, CA\b|, NY\b/i.test(formatted)) {
    return "US";
  }
  if (/\bUnited Kingdom\b|\bUK\b|, England\b|, London\b/i.test(formatted)) {
    return "GB";
  }
  return null;
}

function addressComponentsFromRow(row: readonly unknown[]): Array<{
  longText?: string;
  shortText?: string;
  types: string[];
}> {
  const components: Array<{ longText?: string; shortText?: string; types: string[] }> = [];
  const country = countryFromRow(row);
  const lineParts = row[2];
  let line1: string | null = null;
  let cityLine: string | null = null;
  if (Array.isArray(lineParts) && typeof lineParts[0] === "string") {
    line1 = lineParts[0].trim() === "" ? null : lineParts[0].trim();
  }
  if (Array.isArray(lineParts) && typeof lineParts[1] === "string") {
    cityLine = lineParts[1].trim() === "" ? null : lineParts[1].trim();
  }
  const extra = row[82];
  if (line1 === null && Array.isArray(extra) && typeof extra[1] === "string") {
    line1 = extra[1].trim() === "" ? null : extra[1].trim();
  }
  if (line1 !== null) {
    components.push({ longText: line1, types: ["route"] });
  }
  let city: string | null = null;
  let region: string | null = null;
  let postal: string | null = null;
  if (cityLine !== null) {
    const match = cityLine.match(/^([^,]+),\s*([A-Z]{2})(?:\s+(\d[\d-]*))?$/);
    if (match) {
      city = match[1] ?? null;
      region = match[2] ?? null;
      postal = match[3] ?? null;
    } else {
      city = cityLine.split(",")[0]?.trim() ?? null;
    }
  }
  if (city === null && Array.isArray(extra) && typeof extra[3] === "string") {
    city = extra[3].trim() === "" ? null : extra[3].trim();
  }
  if (city === null) {
    const fallback = stringAt(row, 166);
    if (fallback !== null) {
      city = fallback.split(",")[0]?.trim() ?? null;
    }
  }
  if (city !== null) {
    components.push({ longText: city, types: ["locality"] });
  }
  if (region !== null) {
    components.push({ longText: region, shortText: region, types: ["administrative_area_level_1"] });
  }
  if (postal !== null) {
    components.push({ longText: postal, types: ["postal_code"] });
  }
  if (country !== null) {
    components.push({ shortText: country, longText: country, types: ["country"] });
  }
  return components;
}

function ratingFromRow(row: readonly unknown[]): { average?: number; count?: number } {
  const blob = row[4];
  let average: number | undefined;
  let count: number | undefined;
  if (Array.isArray(blob)) {
    const maybe = blob[7];
    if (typeof maybe === "number" && Number.isFinite(maybe)) {
      average = maybe;
    }
    const maybeCount = blob[8];
    if (typeof maybeCount === "number" && Number.isInteger(maybeCount)) {
      count = maybeCount;
    }
  }
  return { average, count };
}

function websiteFromRow(row: readonly unknown[]): string | null {
  const blob = row[7];
  if (!Array.isArray(blob)) {
    return null;
  }
  const href = blob[0];
  return typeof href === "string" && href.startsWith("http") ? href : null;
}

function phoneFromRow(row: readonly unknown[]): string | null {
  const blob = row[178];
  const strings: string[] = [];
  collectStrings(blob, strings);
  for (const item of strings) {
    if (item.startsWith("+") && /[0-9]/.test(item)) {
      return item;
    }
  }
  for (const item of strings) {
    if (/^\+?[\d().\s-]{7,}$/.test(item) && /\d{3}/.test(item)) {
      return item;
    }
  }
  return null;
}

function categoriesFromRow(row: readonly unknown[]): string[] {
  const blob = row[13];
  if (!Array.isArray(blob)) {
    return [];
  }
  return blob.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function vendorIdFromRow(row: readonly unknown[]): string | null {
  const direct = stringAt(row, 78);
  if (direct !== null && isGooglePlaceId(direct)) {
    return direct;
  }
  const nested = row[227];
  const strings: string[] = [];
  collectStrings(nested, strings);
  for (const item of strings) {
    if (isGooglePlaceId(item)) {
      return item;
    }
  }
  return null;
}

function mapsUrlFromRow(row: readonly unknown[]): string | null {
  const preview = stringAt(row, 42);
  if (preview !== null && preview.includes("/maps/")) {
    return preview.replace("/maps/preview/place/", "/maps/place/");
  }
  const name = stringAt(row, 11);
  const loc = latLngFromRow(row);
  const cid = stringAt(row, 10);
  if (name === null) {
    return null;
  }
  const slug = encodeURIComponent(name).replace(/%20/g, "+");
  if (loc !== undefined) {
    const data = cid !== null ? `/data=!4m2!3m1!1s${cid}` : "";
    return `https://www.google.com/maps/place/${slug}/@${loc.latitude},${loc.longitude},17z${data}`;
  }
  return `https://www.google.com/maps/place/${slug}`;
}

function timeZoneFromRow(row: readonly unknown[]): { id: string } | undefined {
  const tz = stringAt(row, 30);
  return tz === null ? undefined : { id: tz };
}

export function googlePlaceFromPublicRow(row: readonly unknown[]): GooglePlace | null {
  if (!looksLikePlaceRow(row)) {
    return null;
  }
  const name = stringAt(row, 11);
  const formatted = stringAt(row, 18) ?? stringAt(row, 39);
  if (name === null || formatted === null) {
    return null;
  }
  const rating = ratingFromRow(row);
  const loc = latLngFromRow(row);
  const vendorId = vendorIdFromRow(row);
  const mapsUrl = mapsUrlFromRow(row);
  const google: GooglePlace = {
    id: vendorId ?? undefined,
    displayName: { text: name },
    formattedAddress: formatted,
    addressComponents: addressComponentsFromRow(row),
    location: loc,
    nationalPhoneNumber: phoneFromRow(row) ?? undefined,
    websiteUri: websiteFromRow(row) ?? undefined,
    rating: rating.average,
    userRatingCount: rating.count,
    types: categoriesFromRow(row),
    googleMapsUri: mapsUrl ?? undefined,
    timeZone: timeZoneFromRow(row),
  };
  return google;
}

export function publicPlaceRowsToGooglePlaces(payload: unknown): PublicMapsPlaceRow[] {
  const out: PublicMapsPlaceRow[] = [];
  const seen = new Set<string>();
  for (const row of extractPublicMapsPlaceRows(payload)) {
    const google = googlePlaceFromPublicRow(row);
    if (google === null) {
      continue;
    }
    const key =
      (typeof google.id === "string" ? google.id : "") ||
      (typeof google.googleMapsUri === "string" ? google.googleMapsUri : "") ||
      `${displayNameText(google)}|${typeof google.formattedAddress === "string" ? google.formattedAddress : ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      google,
      mapsUrl: typeof google.googleMapsUri === "string" ? google.googleMapsUri : null,
    });
  }
  return out;
}

function displayNameText(raw: GooglePlace): string {
  if (typeof raw.displayName === "string") {
    return raw.displayName;
  }
  if (
    raw.displayName !== null &&
    typeof raw.displayName === "object" &&
    !Array.isArray(raw.displayName) &&
    typeof (raw.displayName as { text?: unknown }).text === "string"
  ) {
    return (raw.displayName as { text: string }).text;
  }
  return "";
}

export function parsePublicMapsPlaceBody(
  body: string,
  mapsUrl: string,
  now: Date,
): Place {
  if (looksLikeBotWall(body)) {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  let payload: unknown;
  try {
    payload = parsePublicMapsJson(body);
  } catch (err) {
    if (err instanceof PlaceError) {
      throw err;
    }
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  const rows = publicPlaceRowsToGooglePlaces(payload);
  const google = pickPlaceForUrl(rows, mapsUrl);
  if (google === null) {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  return placeFromGooglePlace(google, mapsUrl, now);
}

function pickPlaceForUrl(rows: PublicMapsPlaceRow[], mapsUrl: string): GooglePlace | null {
  if (rows.length === 0) {
    return null;
  }
  let slug: string | null = null;
  try {
    slug = extractPlaceSlug(new URL(mapsUrl));
  } catch {
    slug = null;
  }
  if (slug !== null) {
    const slugTokens = new Set(slug.split(" ").filter((token) => token.length > 0));
    const scored = rows
      .map((row) => {
        const name = displayNameText(row.google)
          .normalize("NFKD")
          .toLowerCase()
          .replace(/['’]/g, "")
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
        const tokens = name.split(" ").filter((token) => token.length > 0);
        const overlap = tokens.filter((token) => slugTokens.has(token)).length;
        return { row, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap);
    const best = scored[0];
    if (best !== undefined && best.overlap > 0) {
      return best.row.google;
    }
  }
  return rows[0]?.google ?? null;
}

export function parsePublicMapsSearchBody(body: string): ParsedSearchHit[] {
  if (looksLikeBotWall(body)) {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  let payload: unknown;
  try {
    payload = parsePublicMapsJson(body);
  } catch (err) {
    if (err instanceof PlaceError) {
      throw err;
    }
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  const hits: ParsedSearchHit[] = [];
  const seen = new Set<string>();
  for (const row of publicPlaceRowsToGooglePlaces(payload)) {
    const hit = searchHitFromGooglePlace(row.google);
    if (hit === null) {
      continue;
    }
    if (seen.has(hit.id)) {
      continue;
    }
    seen.add(hit.id);
    hits.push({
      hit,
      vendorPlaceId: vendorPlaceIdOf(row.google),
      raw: row.google,
    });
  }
  return hits;
}

export function publicMapsPlaceLookupUrl(mapsUrl: URL): string {
  const slug = extractPlaceSlug(mapsUrl);
  const query = slug !== null && slug.trim() !== "" ? slug : mapsUrl.toString();
  const params = new URLSearchParams({
    tbm: "map",
    q: query,
    hl: "en",
    gl: "us",
  });
  return `${TBM_MAP_ORIGIN}/search?${params.toString()}`;
}

export function publicMapsSearchLookupUrl(textQuery: string): string {
  const params = new URLSearchParams({
    tbm: "map",
    q: textQuery,
    hl: "en",
    gl: "us",
  });
  return `${TBM_MAP_ORIGIN}/search?${params.toString()}`;
}

export function mapsSearchPageUrl(textQuery: string, city: string | null): string {
  const q = city !== null && city.trim() !== "" ? `${textQuery} ${city}`.trim() : textQuery;
  const path = encodeURIComponent(q).replace(/%20/g, "+");
  return `https://www.google.com/maps/search/${path}`;
}

/** Follow `/search?tbm=map&pb=` from a Maps HTML shell when the bare tbm JSON is a stub. */
export function extractTbmMapHref(html: string): string | null {
  const match = html.match(/href="(\/search\?tbm=map[^"]+)"/i);
  if (match?.[1] === undefined) {
    return null;
  }
  return match[1]
    .replace(/&amp;/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&");
}

export function resolveTbmMapHref(html: string, base = TBM_MAP_ORIGIN): string | null {
  const href = extractTbmMapHref(html);
  if (href === null) {
    return null;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
