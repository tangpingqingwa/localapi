import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { PlaceError } from "../../core/errors.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const PLACES_BY_URL_PATH = "/v1/places/by-url" as const;
export const PLACE_BY_ID_PATH = "/v1/places/:id" as const;
export const PLACE_REVIEWS_PATH = "/v1/places/:id/reviews" as const;
export const PLACE_HOURS_PATH = "/v1/places/:id/hours" as const;

const PLACE_CREDIT = 1;
const REVIEWS_CREDIT = 1;
const HOURS_CREDIT = 1;

export const placesRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { url?: string } }>(
    PLACES_BY_URL_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      if (key.credits < PLACE_CREDIT) {
        return sendErr(reply, "payment_required", "Not enough credits.");
      }
      const started = Date.now();
      try {
        const place = await request.server.adapter.getPlaceByUrl(request.query.url ?? "");
        const charged = tryChargeOrPaymentRequired(
          request.server.db,
          key,
          PLACE_CREDIT,
          PLACES_BY_URL_PATH,
        );
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        return sendOk(reply, place, {
          cached: false,
          creditsCharged: PLACE_CREDIT,
          upstreamMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof PlaceError) {
          return sendErr(reply, err.code, err.message);
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    PLACE_BY_ID_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      if (key.credits < PLACE_CREDIT) {
        return sendErr(reply, "payment_required", "Not enough credits.");
      }
      const started = Date.now();
      try {
        const place = await request.server.adapter.getPlaceById(request.params.id);
        const charged = tryChargeOrPaymentRequired(
          request.server.db,
          key,
          PLACE_CREDIT,
          PLACE_BY_ID_PATH,
        );
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        return sendOk(reply, place, {
          cached: false,
          creditsCharged: PLACE_CREDIT,
          upstreamMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof PlaceError) {
          return sendErr(reply, err.code, err.message);
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { page?: string; lang?: string } }>(
    PLACE_REVIEWS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      if (key.credits < REVIEWS_CREDIT) {
        return sendErr(reply, "payment_required", "Not enough credits.");
      }
      const started = Date.now();
      try {
        const page = await request.server.adapter.getReviewPage(request.params.id, {
          page: request.query.page,
          lang: request.query.lang,
        });
        const charged = tryChargeOrPaymentRequired(
          request.server.db,
          key,
          REVIEWS_CREDIT,
          PLACE_REVIEWS_PATH,
        );
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        return sendOk(reply, page, {
          cached: false,
          creditsCharged: REVIEWS_CREDIT,
          upstreamMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof PlaceError) {
          return sendErr(reply, err.code, err.message);
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    PLACE_HOURS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      if (key.credits < HOURS_CREDIT) {
        return sendErr(reply, "payment_required", "Not enough credits.");
      }
      const started = Date.now();
      try {
        const hours = await request.server.adapter.getHoursByPlaceId(request.params.id);
        const charged = tryChargeOrPaymentRequired(
          request.server.db,
          key,
          HOURS_CREDIT,
          PLACE_HOURS_PATH,
        );
        if (!charged.ok) {
          return sendErr(reply, "payment_required", "Not enough credits.");
        }
        request.apiKey = charged.key;
        return sendOk(reply, hours, {
          cached: false,
          creditsCharged: HOURS_CREDIT,
          upstreamMs: Date.now() - started,
        });
      } catch (err) {
        if (err instanceof PlaceError) {
          return sendErr(reply, err.code, err.message);
        }
        throw err;
      }
    },
  );
};
