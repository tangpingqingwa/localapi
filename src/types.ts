export type ErrorCode =
  | "invalid_request"
  | "invalid_place_url"
  | "search_too_broad"
  | "unauthorized"
  | "payment_required"
  | "place_not_found"
  | "region_unsupported"
  | "daily_cap"
  | "upstream_blocked"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_request",
  "invalid_place_url",
  "search_too_broad",
  "unauthorized",
  "payment_required",
  "place_not_found",
  "region_unsupported",
  "daily_cap",
  "upstream_blocked",
  "internal",
];

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};

export type KeyPrefix = "lk_live" | "lk_test";

export type Plan = "free" | "monthly" | "annual";

export type CountryCode = "US" | "GB";

/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** open/close are HH:MM 24h. Overnight is two intervals; close may be 24:00. */
export type HoursInterval = {
  day: Weekday;
  open: string;
  close: string;
};

export type Hours = {
  timezone: string | null;
  weekly: HoursInterval[];
  note: string | null;
};

/** Public review row from GET /v1/places/{id}/reviews. */
export type Review = {
  id: string | null;
  author: string | null;
  stars: number;
  text: string;
  createdAt: string | null;
  language: string | null;
};

export type ReviewPage = {
  page: number;
  hasMore: boolean;
  language: string | null;
  reviews: Review[];
};

export type PlaceAddress = {
  line1: string | null;
  city: string | null;
  region: string | null;
  postal: string | null;
  country: CountryCode;
  formatted: string;
};

/** Compact hit from GET/POST /v1/search. */
export type SearchHit = {
  id: string;
  name: string;
  address: PlaceAddress;
  location: { lat: number; lng: number } | null;
  rating: { average: number | null; count: number | null };
  categories: string[];
  mapsUrl: string;
};

export type SearchBBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type SearchPage = {
  query: {
    q: string | null;
    city: string | null;
    bbox: SearchBBox | null;
    limit: number;
  };
  results: SearchHit[];
};

/** Public place card from GET /v1/places/by-url and GET /v1/places/{id}. */
export type Place = {
  id: string;
  name: string;
  address: PlaceAddress;
  location: { lat: number; lng: number } | null;
  phone: string | null;
  website: string | null;
  rating: { average: number | null; count: number | null };
  hours: Hours | null;
  categories: string[];
  mapsUrl: string;
  fetchedAt: string;
};
