import { tryCharge, tryChargeOrPaymentRequired } from "../billing/charge.js";
import type { Key } from "../billing/keys.js";
import type { PlacesAdapter } from "../core/adapter.js";
import { PlaceError } from "../core/errors.js";
import { searchCredits, type SearchInput } from "../core/search.js";
import type { LocalApiDb } from "../db.js";
import { isRetryable, newRequestId } from "../http/envelope.js";
import type { Err, ErrorCode, Ok } from "../types.js";

export const GET_PLACE_TOOL = "get_place" as const;
export const LIST_REVIEWS_TOOL = "list_reviews" as const;
export const SEARCH_PLACES_TOOL = "search_places" as const;

export const MCP_TOOL_NAMES = [
  GET_PLACE_TOOL,
  LIST_REVIEWS_TOOL,
  SEARCH_PLACES_TOOL,
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOutcome = Ok<unknown> | Err;

export type CallMcpToolInput = {
  name: string;
  args: Record<string, unknown>;
  db: LocalApiDb;
  key: Key;
  adapter: PlacesAdapter;
  requestId?: string;
};

export const MCP_SKILL =
  "US and UK public business cards only. Not for navigation or directions. " +
  "Ratings are public snapshots. Do not impersonate Google.";

const PLACE_CREDIT = 1;
const REVIEWS_CREDIT = 1;

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: GET_PLACE_TOOL,
    description:
      "Public place card. Maps to GET /v1/places/by-url or GET /v1/places/{id}. " +
      "1 credit on success. Failures charge 0. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description:
            "Google Maps place URL (maps.google.com, google.com/maps, maps.app.goo.gl). One of url or id required.",
        },
        id: {
          type: "string",
          description: "Opaque LocalAPI id plc_… (one of url or id required)",
        },
      },
    },
  },
  {
    name: LIST_REVIEWS_TOOL,
    description:
      "One page of public reviews. Maps to GET /v1/places/{id}/reviews. " +
      "1 credit per page, including empty pages. Never invent a review. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Opaque LocalAPI id plc_…",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "1-based review page (default 1)",
        },
        lang: {
          type: "string",
          description: "Optional language filter (exact match on review.language)",
        },
      },
    },
  },
  {
    name: SEARCH_PLACES_TOOL,
    description:
      "Search US/UK public places. Maps to GET /v1/search. " +
      "Needs city or bbox; q alone is search_too_broad. " +
      "Credits: max(3, resultCount) when any result, else 0. Cap 20. " +
      MCP_SKILL,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        q: {
          type: "string",
          description: "Keyword query (name, category, or address tokens)",
        },
        city: {
          type: "string",
          description: "City name (required unless bbox is set)",
        },
        bbox: {
          description: "west,south,east,north string or {west,south,east,north}",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Max results, cap 20 (default 20)",
        },
      },
    },
  },
];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch an MCP tool to core/* via the app adapter. */
export async function callMcpTool(input: CallMcpToolInput): Promise<McpToolOutcome> {
  const requestId = input.requestId ?? newRequestId();
  if (!isMcpToolName(input.name)) {
    return fail("invalid_request", requestId, `Unknown MCP tool '${input.name}'.`);
  }
  switch (input.name) {
    case GET_PLACE_TOOL:
      return dispatchGetPlace(input, requestId);
    case LIST_REVIEWS_TOOL:
      return dispatchListReviews(input, requestId);
    case SEARCH_PLACES_TOOL:
      return dispatchSearchPlaces(input, requestId);
  }
}

async function dispatchGetPlace(input: CallMcpToolInput, requestId: string): Promise<McpToolOutcome> {
  const url = readStringArg(input.args, "url");
  const id = readStringArg(input.args, "id");
  if (url === undefined && id === undefined) {
    return fail("invalid_request", requestId, "Provide a url or id argument.");
  }
  if (input.key.credits < PLACE_CREDIT) {
    return fail("payment_required", requestId, "Not enough credits.");
  }
  const started = Date.now();
  try {
    const place =
      url !== undefined
        ? await input.adapter.getPlaceByUrl(url)
        : await input.adapter.getPlaceById(id ?? "");
    const route = url !== undefined ? "/v1/places/by-url" : "/v1/places/{id}";
    const charged = tryChargeOrPaymentRequired(input.db, input.key, PLACE_CREDIT, route);
    if (!charged.ok) {
      return fail("payment_required", requestId, "Not enough credits.");
    }
    return ok(place, requestId, PLACE_CREDIT, Date.now() - started);
  } catch (err) {
    return fromPlaceError(err, requestId);
  }
}

async function dispatchListReviews(
  input: CallMcpToolInput,
  requestId: string,
): Promise<McpToolOutcome> {
  if (input.key.credits < REVIEWS_CREDIT) {
    return fail("payment_required", requestId, "Not enough credits.");
  }
  const started = Date.now();
  try {
    const page = await input.adapter.getReviewPage(readStringArg(input.args, "id") ?? "", {
      page: readPageArg(input.args, "page"),
      lang: readStringArg(input.args, "lang"),
    });
    const charged = tryChargeOrPaymentRequired(
      input.db,
      input.key,
      REVIEWS_CREDIT,
      "/v1/places/{id}/reviews",
    );
    if (!charged.ok) {
      return fail("payment_required", requestId, "Not enough credits.");
    }
    return ok(page, requestId, REVIEWS_CREDIT, Date.now() - started);
  } catch (err) {
    return fromPlaceError(err, requestId);
  }
}

async function dispatchSearchPlaces(
  input: CallMcpToolInput,
  requestId: string,
): Promise<McpToolOutcome> {
  const started = Date.now();
  try {
    const page = await input.adapter.searchPlaces(searchInputFromArgs(input.args));
    const credits = searchCredits(page.results.length);
    const charged = tryCharge(input.db, input.key, credits, "/v1/search");
    if (!charged.ok) {
      if (charged.code === "daily_cap") {
        return fail("daily_cap", requestId, "Daily credit cap reached for this key.");
      }
      return fail("payment_required", requestId, "Not enough credits.");
    }
    return ok(page, requestId, credits, Date.now() - started);
  } catch (err) {
    return fromPlaceError(err, requestId);
  }
}

function searchInputFromArgs(args: Record<string, unknown>): SearchInput {
  return {
    q: readStringArg(args, "q"),
    city: readStringArg(args, "city"),
    bbox: readBboxArg(args),
    limit: readPageArg(args, "limit"),
  };
}

function readBboxArg(args: Record<string, unknown>): SearchInput["bbox"] {
  const value = args.bbox;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    return value as { west: number; south: number; east: number; north: number };
  }
  return String(value);
}

function fromPlaceError(err: unknown, requestId: string): Err {
  if (err instanceof PlaceError) {
    return fail(err.code, requestId, err.message);
  }
  throw err;
}

function ok(
  data: unknown,
  requestId: string,
  creditsCharged: number,
  upstreamMs: number,
): Ok<unknown> {
  return {
    data,
    meta: {
      cached: false,
      creditsCharged,
      requestId,
      upstreamMs,
    },
  };
}

function fail(code: ErrorCode, requestId: string, message: string): Err {
  return {
    error: { code, message, retryable: isRetryable(code) },
    meta: { creditsCharged: 0, requestId },
  };
}

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readPageArg(
  args: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
