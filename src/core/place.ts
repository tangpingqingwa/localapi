import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CountryCode, Place, PlaceAddress } from "../types.js";
import { PlaceError } from "./errors.js";

export const PLACE_FIXTURE_COUNT = 30;
export const PLACE_ID_PREFIX = "plc_" as const;

const FIXTURES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/places.json",
);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);

/** Contiguous US, Alaska, Hawaii. */
const US_BOXES: ReadonlyArray<{ lat: [number, number]; lng: [number, number] }> = [
  { lat: [24.5, 49.5], lng: [-124.8, -66.9] },
  { lat: [51, 72], lng: [-180, -129] },
  { lat: [18.9, 22.3], lng: [-160.3, -154.8] },
];

/** United Kingdom including NI. */
const UK_BOX = { lat: [49.8, 60.9] as [number, number], lng: [-8.2, 1.8] as [number, number] };

export type PlaceFixture = {
  slug: string;
  mapsUrl: string;
  shortUrl?: string;
  name: string;
  address: PlaceAddress;
  location: { lat: number; lng: number } | null;
  phone: string | null;
  website: string | null;
  rating: { average: number | null; count: number | null };
  categories: string[];
};

type Catalog = {
  fixtures: PlaceFixture[];
  byId: Map<string, PlaceFixture>;
  byNormalizedUrl: Map<string, PlaceFixture>;
  byPlaceSlug: Map<string, PlaceFixture>;
  byCid: Map<string, PlaceFixture>;
};

let cachedCatalog: Catalog | undefined;

function inBox(
  lat: number,
  lng: number,
  box: { lat: [number, number]; lng: [number, number] },
): boolean {
  return lat >= box.lat[0] && lat <= box.lat[1] && lng >= box.lng[0] && lng <= box.lng[1];
}

export function isUsOrUkLatLng(lat: number, lng: number): boolean {
  if (inBox(lat, lng, UK_BOX)) {
    return true;
  }
  return US_BOXES.some((box) => inBox(lat, lng, box));
}

function hostWithoutWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function isGoogleMapsHost(host: string): boolean {
  const h = hostWithoutWww(host);
  if (SHORT_HOSTS.has(h)) {
    return true;
  }
  if (h === "maps.google.com" || h.startsWith("maps.google.")) {
    return true;
  }
  if (h === "google.com" || /^google\.[a-z]{2,}(?:\.[a-z]{2})?$/.test(h)) {
    return true;
  }
  return false;
}

function isShortMapsHost(host: string): boolean {
  return SHORT_HOSTS.has(hostWithoutWww(host));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function normalizeMapsUrl(raw: string): string {
  const url = new URL(raw);
  url.protocol = "https:";
  url.hostname = hostWithoutWww(url.hostname);
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "hl" || key === "gl" || key === "entry") {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function placeIdFromCanonical(canonicalUrl: string): string {
  const digest = createHash("sha256")
    .update(`maps:${normalizeMapsUrl(canonicalUrl)}`, "utf8")
    .digest();
  return `${PLACE_ID_PREFIX}${base32Encode(digest.subarray(0, 10))}`;
}

export function extractPlaceSlug(url: URL): string | null {
  const match = url.pathname.match(/\/maps\/place\/([^/]+)/i);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return decodeURIComponent(match[1].replace(/\+/g, " "))
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function extractCid(url: URL): string | null {
  const cid = url.searchParams.get("cid");
  return cid !== null && cid !== "" ? cid : null;
}

export function extractLatLng(url: URL): { lat: number; lng: number } | null {
  const fromPath = url.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const raw = fromPath ?? url.searchParams.get("q")?.match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (raw === null || raw === undefined || raw[1] === undefined || raw[2] === undefined) {
    return null;
  }
  const lat = Number(raw[1]);
  const lng = Number(raw[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function parseAbsoluteHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed;
}

/** True when the URL is a Google Maps *place* link, not search/dir/viewport. */
export function isMapsPlaceUrl(raw: string): boolean {
  const url = parseAbsoluteHttpUrl(raw);
  if (url === null || !isGoogleMapsHost(url.hostname)) {
    return false;
  }
  if (isShortMapsHost(url.hostname)) {
    const token = url.pathname.replace(/^\/+|\/+$/g, "");
    return token.length > 0 && token.toLowerCase() !== "maps";
  }
  const path = url.pathname.toLowerCase();
  const host = hostWithoutWww(url.hostname);
  const onDedicatedMapsHost = host.startsWith("maps.google.");
  const onGoogleMapsPath = path === "/maps" || path.startsWith("/maps/");
  if (!onDedicatedMapsHost && !onGoogleMapsPath) {
    return false;
  }
  if (path.includes("/maps/dir") || path.includes("/maps/search")) {
    return false;
  }
  if (path.includes("/maps/place/")) {
    return extractPlaceSlug(url) !== null;
  }
  return extractCid(url) !== null;
}

function assertFixture(raw: unknown, index: number): PlaceFixture {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`fixtures/places.json[${index}] is not an object`);
  }
  const row = raw as Record<string, unknown>;
  const addressRaw = row.address;
  if (addressRaw === null || typeof addressRaw !== "object") {
    throw new Error(`fixtures/places.json[${index}] missing address`);
  }
  const addressObj = addressRaw as Record<string, unknown>;
  const country = addressObj.country;
  if (country !== "US" && country !== "GB") {
    throw new Error(`fixtures/places.json[${index}] country must be US or GB`);
  }
  const formatted = addressObj.formatted;
  const name = row.name;
  const mapsUrl = row.mapsUrl;
  const slug = row.slug;
  if (typeof slug !== "string" || slug === "") {
    throw new Error(`fixtures/places.json[${index}] missing slug`);
  }
  if (typeof name !== "string" || name === "") {
    throw new Error(`fixtures/places.json[${index}] missing name`);
  }
  if (typeof mapsUrl !== "string" || mapsUrl === "") {
    throw new Error(`fixtures/places.json[${index}] missing mapsUrl`);
  }
  if (typeof formatted !== "string" || formatted === "") {
    throw new Error(`fixtures/places.json[${index}] missing formatted address`);
  }
  const locationRaw = row.location;
  let location: { lat: number; lng: number } | null = null;
  if (locationRaw !== null && locationRaw !== undefined) {
    if (typeof locationRaw !== "object") {
      throw new Error(`fixtures/places.json[${index}] location must be object or null`);
    }
    const loc = locationRaw as Record<string, unknown>;
    if (typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      throw new Error(`fixtures/places.json[${index}] location.lat/lng must be numbers`);
    }
    location = { lat: loc.lat, lng: loc.lng };
  }
  const ratingRaw = row.rating;
  if (ratingRaw === null || typeof ratingRaw !== "object") {
    throw new Error(`fixtures/places.json[${index}] missing rating`);
  }
  const ratingObj = ratingRaw as Record<string, unknown>;
  const categories = row.categories;
  if (!Array.isArray(categories) || categories.some((item) => typeof item !== "string")) {
    throw new Error(`fixtures/places.json[${index}] categories must be string[]`);
  }
  const phone = row.phone;
  const website = row.website;
  if (phone !== null && typeof phone !== "string") {
    throw new Error(`fixtures/places.json[${index}] phone must be string or null`);
  }
  if (website !== null && typeof website !== "string") {
    throw new Error(`fixtures/places.json[${index}] website must be string or null`);
  }
  const fixture: PlaceFixture = {
    slug,
    mapsUrl,
    name,
    address: {
      line1: typeof addressObj.line1 === "string" ? addressObj.line1 : null,
      city: typeof addressObj.city === "string" ? addressObj.city : null,
      region: typeof addressObj.region === "string" ? addressObj.region : null,
      postal: typeof addressObj.postal === "string" ? addressObj.postal : null,
      country,
      formatted,
    },
    location,
    phone,
    website,
    rating: {
      average: typeof ratingObj.average === "number" ? ratingObj.average : null,
      count: typeof ratingObj.count === "number" ? ratingObj.count : null,
    },
    categories: categories as string[],
  };
  if (typeof row.shortUrl === "string" && row.shortUrl !== "") {
    fixture.shortUrl = row.shortUrl;
  }
  return fixture;
}

export function loadPlaceFixtures(): PlaceFixture[] {
  return loadCatalog().fixtures;
}

function loadCatalog(): Catalog {
  if (cachedCatalog !== undefined) {
    return cachedCatalog;
  }
  const parsed: unknown = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("fixtures/places.json must be an array");
  }
  if (parsed.length !== PLACE_FIXTURE_COUNT) {
    throw new Error(`fixtures/places.json must contain ${PLACE_FIXTURE_COUNT} places`);
  }
  const fixtures = parsed.map((row, index) => assertFixture(row, index));
  const slugs = new Set<string>();
  const byId = new Map<string, PlaceFixture>();
  const byNormalizedUrl = new Map<string, PlaceFixture>();
  const byPlaceSlug = new Map<string, PlaceFixture>();
  const byCid = new Map<string, PlaceFixture>();
  for (const fixture of fixtures) {
    if (slugs.has(fixture.slug)) {
      throw new Error(`duplicate fixture slug: ${fixture.slug}`);
    }
    slugs.add(fixture.slug);
    const id = placeIdFromCanonical(fixture.mapsUrl);
    byId.set(id, fixture);
    byNormalizedUrl.set(normalizeMapsUrl(fixture.mapsUrl), fixture);
    if (fixture.shortUrl !== undefined) {
      byNormalizedUrl.set(normalizeMapsUrl(fixture.shortUrl), fixture);
    }
    const maps = new URL(fixture.mapsUrl);
    const slug = extractPlaceSlug(maps);
    if (slug !== null) {
      byPlaceSlug.set(slug, fixture);
    }
    const cid = extractCid(maps);
    if (cid !== null) {
      byCid.set(cid, fixture);
    }
  }
  cachedCatalog = { fixtures, byId, byNormalizedUrl, byPlaceSlug, byCid };
  return cachedCatalog;
}

function toPlace(fixture: PlaceFixture, now: Date): Place {
  return {
    id: placeIdFromCanonical(fixture.mapsUrl),
    name: fixture.name,
    address: {
      line1: fixture.address.line1,
      city: fixture.address.city,
      region: fixture.address.region,
      postal: fixture.address.postal,
      country: fixture.address.country as CountryCode,
      formatted: fixture.address.formatted,
    },
    location: fixture.location === null ? null : { ...fixture.location },
    phone: fixture.phone,
    website: fixture.website,
    rating: { ...fixture.rating },
    hours: null,
    categories: [...fixture.categories],
    mapsUrl: fixture.mapsUrl,
    fetchedAt: now.toISOString(),
  };
}

function matchFixture(url: URL): PlaceFixture | undefined {
  const catalog = loadCatalog();
  const normalized = catalog.byNormalizedUrl.get(normalizeMapsUrl(url.toString()));
  if (normalized !== undefined) {
    return normalized;
  }
  const cid = extractCid(url);
  if (cid !== null) {
    const byCid = catalog.byCid.get(cid);
    if (byCid !== undefined) {
      return byCid;
    }
  }
  const slug = extractPlaceSlug(url);
  if (slug !== null) {
    return catalog.byPlaceSlug.get(slug);
  }
  return undefined;
}

function rejectUnmatchedPlace(url: URL): never {
  const coords = extractLatLng(url);
  if (coords !== null && !isUsOrUkLatLng(coords.lat, coords.lng)) {
    throw new PlaceError(
      "region_unsupported",
      "This place is outside United States and United Kingdom coverage.",
    );
  }
  throw new PlaceError("place_not_found", "Place not found.");
}

export function getPlaceByUrl(url: string, now: Date = new Date()): Place {
  const trimmed = url.trim();
  if (trimmed === "") {
    throw new PlaceError("invalid_request", "Query parameter url is required.");
  }
  if (!isMapsPlaceUrl(trimmed)) {
    throw new PlaceError("invalid_place_url", "Not a Google Maps place URL.");
  }
  const parsed = parseAbsoluteHttpUrl(trimmed);
  if (parsed === null) {
    throw new PlaceError("invalid_place_url", "Not a Google Maps place URL.");
  }
  const fixture = matchFixture(parsed);
  if (fixture === undefined) {
    if (isShortMapsHost(parsed.hostname)) {
      throw new PlaceError("place_not_found", "Place not found.");
    }
    rejectUnmatchedPlace(parsed);
  }
  return toPlace(fixture, now);
}

export function getPlaceById(id: string, now: Date = new Date()): Place {
  const trimmed = id.trim();
  if (trimmed === "") {
    throw new PlaceError("invalid_request", "Place id is required.");
  }
  const fixture = loadCatalog().byId.get(trimmed);
  if (fixture === undefined) {
    throw new PlaceError("place_not_found", "Place not found.");
  }
  return toPlace(fixture, now);
}
