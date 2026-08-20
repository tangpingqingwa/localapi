import type { PlaceIndex, PlacesAdapter } from "../../core/adapter.js";
import { PlaceError } from "../../core/errors.js";
import { createMemoryPlaceIndex } from "../../core/place-index.js";
import {
  extractLatLng,
  isMapsPlaceUrl,
  normalizeMapsUrl,
  placeIdFromCanonical,
} from "../../core/place.js";
import { parseReviewLang, parseReviewPage, REVIEWS_PAGE_SIZE } from "../../core/reviews.js";
import { parseSearchRequest } from "../../core/search.js";
import type { Place, ReviewPage, SearchPage } from "../../types.js";
import {
  extractGooglePlaceId,
  parseSearchResponse,
  placeFromGooglePlace,
  rejectIfOutsideCoverage,
  reviewsFromGooglePlace,
  textQueryFromMapsUrl,
  vendorPlaceIdOf,
  type GooglePlace,
  type ParsedSearchHit,
} from "./parse.js";

export const PLACES_API_HOST = "places.googleapis.com";
export const PLACE_GET_URL = `https://${PLACES_API_HOST}/v1/places`;
export const PLACE_SEARCH_URL = `https://${PLACES_API_HOST}/v1/places:searchText`;

export const PLACE_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "location",
  "nationalPhoneNumber",
  "websiteUri",
  "rating",
  "userRatingCount",
  "regularOpeningHours",
  "types",
  "googleMapsUri",
  "reviews",
  "timeZone",
].join(",");

export const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.types",
  "places.googleMapsUri",
].join(",");

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const LIVE_TIMEOUT_MS = 8_000;

export type LiveFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; url: string; json: () => Promise<unknown> }>;

export type LiveMapsAdapterOptions = {
  apiKey: string;
  placeIndex?: PlaceIndex;
  fetchImpl?: LiveFetch;
  now?: () => Date;
};

type ResolvedMapsUrl = {
  url: URL;
  canonical: string;
};

export function createLiveMapsAdapter(options: LiveMapsAdapterOptions): PlacesAdapter {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") {
    throw new Error("LOCALAPI_MAPS_API_KEY must be a non-empty Places API key");
  }
  const index = options.placeIndex ?? createMemoryPlaceIndex();
  const fetchImpl = options.fetchImpl ?? defaultLiveFetch;
  const nowFn = options.now ?? (() => new Date());

  async function fetchGooglePlace(placeId: string): Promise<GooglePlace> {
    const url = `${PLACE_GET_URL}/${encodeURIComponent(placeId)}`;
    const body = await placesRequest(fetchImpl, url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": PLACE_FIELD_MASK,
      },
    });
    if (body === null || typeof body !== "object") {
      throw new PlaceError("place_not_found", "Place not found.");
    }
    return body as GooglePlace;
  }

  async function searchGooglePlaces(
    textQuery: string,
    pageSize: number,
    location?: {
      rectangle?: {
        low: { latitude: number; longitude: number };
        high: { latitude: number; longitude: number };
      };
      circle?: { center: { latitude: number; longitude: number }; radius: number };
    },
  ): Promise<ParsedSearchHit[]> {
    const payload: Record<string, unknown> = { textQuery, pageSize };
    if (location?.rectangle !== undefined) {
      payload.locationRestriction = { rectangle: location.rectangle };
    } else if (location?.circle !== undefined) {
      payload.locationBias = { circle: location.circle };
    }
    const body = await placesRequest(fetchImpl, PLACE_SEARCH_URL, {
      method: "POST",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return parseSearchResponse(body);
  }

  async function resolvePlaceFromUrl(rawUrl: string, now: Date): Promise<Place> {
    const trimmed = rawUrl.trim();
    if (trimmed === "") {
      throw new PlaceError("invalid_request", "Query parameter url is required.");
    }
    if (!isMapsPlaceUrl(trimmed)) {
      throw new PlaceError("invalid_place_url", "Not a Google Maps place URL.");
    }
    const resolved = await resolveMapsUrl(fetchImpl, trimmed);
    rejectIfOutsideCoverage(resolved.url);

    const requestCanonical = normalizeMapsUrl(trimmed);
    const cached =
      index.getByMapsUrl(requestCanonical) ?? index.getByMapsUrl(resolved.canonical);
    const vendorId = cached?.vendorPlaceId ?? extractGooglePlaceId(resolved.url);
    let google: GooglePlace;
    if (vendorId !== null) {
      google = await fetchGooglePlace(vendorId);
    } else {
      google = await findPlaceFromMapsUrl(resolved.url, searchGooglePlaces, fetchGooglePlace);
    }
    const mapsUrl = requestCanonical;
    const place = placeFromGooglePlace(google, mapsUrl, now);
    index.put({
      id: place.id,
      mapsUrl,
      vendorPlaceId: vendorPlaceIdOf(google),
    });
    return place;
  }

  async function loadIndexedPlace(id: string, now: Date): Promise<{
    place: Place;
    google: GooglePlace;
  }> {
    const trimmed = id.trim();
    if (trimmed === "") {
      throw new PlaceError("invalid_request", "Place id is required.");
    }
    const row = index.getById(trimmed);
    if (row === undefined) {
      throw new PlaceError("place_not_found", "Place not found.");
    }
    let google: GooglePlace;
    if (row.vendorPlaceId !== null) {
      google = await fetchGooglePlace(row.vendorPlaceId);
    } else {
      const resolved = await resolveMapsUrl(fetchImpl, row.mapsUrl);
      google = await findPlaceFromMapsUrl(resolved.url, searchGooglePlaces, fetchGooglePlace);
    }
    const place = placeFromGooglePlace(google, row.mapsUrl, now);
    if (place.id !== row.id) {
      throw new PlaceError("place_not_found", "Place not found.");
    }
    index.put({
      id: row.id,
      mapsUrl: row.mapsUrl,
      vendorPlaceId: vendorPlaceIdOf(google) ?? row.vendorPlaceId,
    });
    return { place, google };
  }

  return {
    kind: "live",
    async getPlaceByUrl(url, now) {
      return resolvePlaceFromUrl(url, now ?? nowFn());
    },
    async getPlaceById(id, now) {
      const loaded = await loadIndexedPlace(id, now ?? nowFn());
      return loaded.place;
    },
    async getReviewPage(placeId, query = {}) {
      const loaded = await loadIndexedPlace(placeId, nowFn());
      const page = parseReviewPage(query.page);
      if (page === null) {
        throw new PlaceError("invalid_request", "page must be a positive integer.");
      }
      const language = parseReviewLang(query.lang);
      const all = reviewsFromGooglePlace(loaded.google);
      const filtered =
        language === null ? all : all.filter((review) => review.language === language);
      const start = (page - 1) * REVIEWS_PAGE_SIZE;
      const slice = filtered.slice(start, start + REVIEWS_PAGE_SIZE);
      return {
        page,
        hasMore: start + slice.length < filtered.length,
        language,
        reviews: slice,
      } satisfies ReviewPage;
    },
    async getHoursByPlaceId(id) {
      const loaded = await loadIndexedPlace(id, nowFn());
      return loaded.place.hours;
    },
    async searchPlaces(input) {
      const parsed = parseSearchRequest(input);
      const textQuery = searchTextQuery(parsed.q, parsed.city);
      const location = searchLocation(parsed);
      const hits = await searchGooglePlaces(textQuery, parsed.limit, location);
      const results = hits.slice(0, parsed.limit);
      for (const row of results) {
        index.put({
          id: row.hit.id,
          mapsUrl: row.hit.mapsUrl,
          vendorPlaceId: row.vendorPlaceId,
        });
      }
      return {
        query: parsed,
        results: results.map((row) => row.hit),
      } satisfies SearchPage;
    },
  };
}

async function findPlaceFromMapsUrl(
  url: URL,
  search: (
    textQuery: string,
    pageSize: number,
    location?: {
      circle?: { center: { latitude: number; longitude: number }; radius: number };
    },
  ) => Promise<ParsedSearchHit[]>,
  fetchPlace: (placeId: string) => Promise<GooglePlace>,
): Promise<GooglePlace> {
  const text = textQueryFromMapsUrl(url);
  if (text === null) {
    rejectIfOutsideCoverage(url);
    throw new PlaceError("place_not_found", "Place not found.");
  }
  const coords = extractLatLng(url);
  const hits = await search(
    text,
    3,
    coords === null
      ? undefined
      : { circle: { center: { latitude: coords.lat, longitude: coords.lng }, radius: 250 } },
  );
  const first = hits[0];
  if (first === undefined) {
    rejectIfOutsideCoverage(url);
    throw new PlaceError("place_not_found", "Place not found.");
  }
  if (first.vendorPlaceId !== null) {
    return fetchPlace(first.vendorPlaceId);
  }
  return first.raw;
}

function searchTextQuery(q: string | null, city: string | null): string {
  if (q !== null && city !== null) {
    return `${q} in ${city}`;
  }
  if (q !== null) {
    return q;
  }
  if (city !== null) {
    return city;
  }
  return "places";
}

function searchLocation(parsed: { q: string | null; city: string | null; bbox: SearchPage["query"]["bbox"] }):
  | {
      rectangle?: {
        low: { latitude: number; longitude: number };
        high: { latitude: number; longitude: number };
      };
    }
  | undefined {
  if (parsed.bbox === null) {
    return undefined;
  }
  return {
    rectangle: {
      low: { latitude: parsed.bbox.south, longitude: parsed.bbox.west },
      high: { latitude: parsed.bbox.north, longitude: parsed.bbox.east },
    },
  };
}

async function resolveMapsUrl(fetchImpl: LiveFetch, raw: string): Promise<ResolvedMapsUrl> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PlaceError("invalid_place_url", "Not a Google Maps place URL.");
  }
  if (SHORT_HOSTS.has(hostWithoutWww(parsed.hostname))) {
    const finalUrl = await followShortUrl(fetchImpl, parsed.toString());
    if (!isMapsPlaceUrl(finalUrl) || SHORT_HOSTS.has(hostWithoutWww(new URL(finalUrl).hostname))) {
      throw new PlaceError("place_not_found", "Place not found.");
    }
    parsed = new URL(finalUrl);
  }
  const canonical = normalizeMapsUrl(parsed.toString());
  return { url: new URL(canonical), canonical };
}

async function followShortUrl(fetchImpl: LiveFetch, url: string): Promise<string> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": "localapi/0.1 (public business information)" },
    });
    if (response.url !== "" && response.url !== url) {
      return response.url;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new PlaceError("place_not_found", "Place not found.");
    }
    return response.url === "" ? url : response.url;
  } catch (err) {
    if (err instanceof PlaceError) {
      throw err;
    }
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
}

async function placesRequest(
  fetchImpl: LiveFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<unknown> {
  let response: { status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof PlaceError) {
      throw err;
    }
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  if (response.status === 404) {
    throw new PlaceError("place_not_found", "Place not found.");
  }
  if (response.status === 400) {
    throw new PlaceError("place_not_found", "Place not found.");
  }
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
  try {
    return await response.json();
  } catch {
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  }
}

async function defaultLiveFetch(
  input: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; url: string; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const response = await fetch(input, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "follow",
      signal: controller.signal,
    });
    return {
      status: response.status,
      url: response.url,
      json: async () => response.json() as Promise<unknown>,
    };
  } catch (err) {
    if (err instanceof PlaceError) {
      throw err;
    }
    throw new PlaceError("upstream_blocked", "The upstream Maps host blocked this request.");
  } finally {
    clearTimeout(timer);
  }
}

function hostWithoutWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function livePlaceIdFromUrl(url: string): string {
  return placeIdFromCanonical(url);
}
