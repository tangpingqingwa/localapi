import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { tryCharge } from "../../billing/charge.js";
import { PlaceError } from "../../core/errors.js";
import { searchCredits, searchPlaces, type SearchInput } from "../../core/search.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const SEARCH_PATH = "/v1/search" as const;

type SearchQuery = {
  q?: string;
  city?: string;
  bbox?: string;
  limit?: string;
};

type SearchBody = {
  q?: string;
  city?: string;
  bbox?: string | { west: number; south: number; east: number; north: number };
  limit?: string | number;
};

function inputFromQuery(query: SearchQuery): SearchInput {
  return {
    q: query.q,
    city: query.city,
    bbox: query.bbox,
    limit: query.limit,
  };
}

function inputFromBody(body: SearchBody | undefined): SearchInput {
  const row = body ?? {};
  return {
    q: row.q,
    city: row.city,
    bbox: row.bbox,
    limit: row.limit,
  };
}

async function handleSearch(
  request: FastifyRequest,
  reply: FastifyReply,
  input: SearchInput,
): Promise<FastifyReply> {
  const key = request.apiKey;
  if (key === undefined) {
    return sendErr(reply, "internal", "Authenticated route missing key.");
  }
  const started = Date.now();
  try {
    const page = searchPlaces(input);
    const credits = searchCredits(page.results.length);
    const charged = tryCharge(request.server.db, key, credits, SEARCH_PATH);
    if (!charged.ok) {
      if (charged.code === "daily_cap") {
        return sendErr(reply, "daily_cap", "Daily credit cap reached for this key.");
      }
      return sendErr(reply, "payment_required", "Not enough credits.");
    }
    request.apiKey = charged.key;
    return sendOk(reply, page, {
      cached: false,
      creditsCharged: credits,
      upstreamMs: Date.now() - started,
    });
  } catch (err) {
    if (err instanceof PlaceError) {
      return sendErr(reply, err.code, err.message);
    }
    throw err;
  }
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: SearchQuery }>(
    SEARCH_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      return handleSearch(request, reply, inputFromQuery(request.query));
    },
  );

  app.post<{ Body: SearchBody }>(
    SEARCH_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      return handleSearch(request, reply, inputFromBody(request.body));
    },
  );
};
