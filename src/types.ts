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
