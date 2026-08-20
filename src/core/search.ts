import type { SearchBBox, SearchHit, SearchPage } from "../types.js";
import { PlaceError } from "./errors.js";
import { loadPlaceFixtures, placeIdFromCanonical, type PlaceFixture } from "./place.js";

/** SPEC 4.5 / BUILD §3: charge max(3, n) when any result, else 0. */
export const SEARCH_MIN_CREDITS = 3;
export const SEARCH_LIMIT_MAX = 20;
export const SEARCH_LIMIT_DEFAULT = SEARCH_LIMIT_MAX;

/** SPEC 3: coffee + Austin is empty — the 30-place catalog has no Austin coffee shop. */
export const DOCUMENTED_EMPTY_COFFEE_AUSTIN = { q: "coffee", city: "Austin" } as const;

/** City-scale boxes only. Wider than this is search_too_broad. */
export const SEARCH_MAX_BBOX_SPAN_DEG = 2;

export type BBox = SearchBBox;

export type SearchInput = {
  q?: string;
  city?: string;
  bbox?: string | BBox;
  limit?: string | number;
};

export function searchCredits(resultCount: number): number {
  if (!Number.isInteger(resultCount) || resultCount < 0) {
    throw new Error("resultCount must be a non-negative integer");
  }
  if (resultCount === 0) {
    return 0;
  }
  return Math.max(SEARCH_MIN_CREDITS, resultCount);
}

export function parseSearchLimit(value: string | number | undefined): number | null {
  if (value === undefined || value === "") {
    return SEARCH_LIMIT_DEFAULT;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      return null;
    }
    return Math.min(value, SEARCH_LIMIT_MAX);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return Math.min(parsed, SEARCH_LIMIT_MAX);
}

function parseFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function parseBbox(value: string | BBox | undefined): BBox | null | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "object") {
    const { west, south, east, north } = value;
    if (
      typeof west !== "number" ||
      typeof south !== "number" ||
      typeof east !== "number" ||
      typeof north !== "number" ||
      !Number.isFinite(west) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(north)
    ) {
      return null;
    }
    return { west, south, east, north };
  }
  const parts = value.split(",");
  if (
    parts.length !== 4 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined
  ) {
    return null;
  }
  const west = parseFiniteNumber(parts[0]);
  const south = parseFiniteNumber(parts[1]);
  const east = parseFiniteNumber(parts[2]);
  const north = parseFiniteNumber(parts[3]);
  if (west === null || south === null || east === null || north === null) {
    return null;
  }
  return { west, south, east, north };
}

export function assertValidBbox(bbox: BBox): void {
  if (bbox.west < -180 || bbox.west > 180 || bbox.east < -180 || bbox.east > 180) {
    throw new PlaceError("invalid_request", "bbox west/east must be between -180 and 180.");
  }
  if (bbox.south < -90 || bbox.south > 90 || bbox.north < -90 || bbox.north > 90) {
    throw new PlaceError("invalid_request", "bbox south/north must be between -90 and 90.");
  }
  if (bbox.west > bbox.east || bbox.south > bbox.north) {
    throw new PlaceError("invalid_request", "bbox must be west,south,east,north with west≤east and south≤north.");
  }
  const spanLng = bbox.east - bbox.west;
  const spanLat = bbox.north - bbox.south;
  if (spanLng > SEARCH_MAX_BBOX_SPAN_DEG || spanLat > SEARCH_MAX_BBOX_SPAN_DEG) {
    throw new PlaceError(
      "search_too_broad",
      `bbox exceeds ${SEARCH_MAX_BBOX_SPAN_DEG}°; pass a city or a smaller box.`,
    );
  }
}

function normalizeCity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(",")[0]!
    .trim();
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function matchesQuery(fixture: PlaceFixture, q: string | null): boolean {
  if (q === null) {
    return true;
  }
  const tokens = tokenize(q);
  if (tokens.length === 0) {
    return true;
  }
  const hay = [
    fixture.name,
    fixture.slug,
    fixture.address.formatted,
    fixture.address.city ?? "",
    ...fixture.categories,
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

function matchesCity(fixture: PlaceFixture, city: string | null): boolean {
  if (city === null) {
    return true;
  }
  const want = normalizeCity(city);
  if (want === "") {
    return true;
  }
  const have = fixture.address.city === null ? "" : normalizeCity(fixture.address.city);
  return have === want;
}

function inBbox(fixture: PlaceFixture, bbox: BBox | null): boolean {
  if (bbox === null) {
    return true;
  }
  if (fixture.location === null) {
    return false;
  }
  const { lat, lng } = fixture.location;
  return lng >= bbox.west && lng <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function toHit(fixture: PlaceFixture): SearchHit {
  return {
    id: placeIdFromCanonical(fixture.mapsUrl),
    name: fixture.name,
    address: {
      line1: fixture.address.line1,
      city: fixture.address.city,
      region: fixture.address.region,
      postal: fixture.address.postal,
      country: fixture.address.country,
      formatted: fixture.address.formatted,
    },
    location: fixture.location === null ? null : { ...fixture.location },
    rating: { ...fixture.rating },
    categories: [...fixture.categories],
    mapsUrl: fixture.mapsUrl,
  };
}

function compareHits(a: PlaceFixture, b: PlaceFixture): number {
  const ac = a.rating.count ?? -1;
  const bc = b.rating.count ?? -1;
  if (ac !== bc) {
    return bc - ac;
  }
  return a.name.localeCompare(b.name);
}

export type ParsedSearchRequest = {
  q: string | null;
  city: string | null;
  bbox: BBox | null;
  limit: number;
};

/** Shared validation for fixture and live search. Failures charge 0. */
export function parseSearchRequest(input: SearchInput = {}): ParsedSearchRequest {
  const qRaw = typeof input.q === "string" ? input.q.trim() : "";
  const cityRaw = typeof input.city === "string" ? input.city.trim() : "";
  const q = qRaw === "" ? null : qRaw;
  const city = cityRaw === "" ? null : cityRaw;
  const bbox = parseBbox(input.bbox);
  if (bbox === null) {
    throw new PlaceError("invalid_request", "bbox must be west,south,east,north.");
  }
  if (bbox !== undefined) {
    assertValidBbox(bbox);
  }
  const resolvedBbox = bbox === undefined ? null : bbox;
  if (city === null && resolvedBbox === null) {
    throw new PlaceError(
      "search_too_broad",
      "Search needs a city or a bbox; q alone is not enough.",
    );
  }
  const limit = parseSearchLimit(input.limit);
  if (limit === null) {
    throw new PlaceError("invalid_request", "limit must be a positive integer.");
  }
  return { q, city, bbox: resolvedBbox, limit };
}

export function searchPlaces(input: SearchInput = {}): SearchPage {
  const { q, city, bbox: resolvedBbox, limit } = parseSearchRequest(input);

  const matched = loadPlaceFixtures()
    .filter((fixture) => matchesCity(fixture, city))
    .filter((fixture) => inBbox(fixture, resolvedBbox))
    .filter((fixture) => matchesQuery(fixture, q))
    .sort(compareHits)
    .slice(0, limit);

  return {
    query: { q, city, bbox: resolvedBbox, limit },
    results: matched.map(toHit),
  };
}
