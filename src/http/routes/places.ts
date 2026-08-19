import type { FastifyPluginAsync } from "fastify";
import { tryChargeOrPaymentRequired } from "../../billing/charge.js";
import { PlaceError } from "../../core/errors.js";
import { getPlaceById, getPlaceByUrl } from "../../core/place.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const PLACES_BY_URL_PATH = "/v1/places/by-url" as const;
export const PLACE_BY_ID_PATH = "/v1/places/:id" as const;

const PLACE_CREDIT = 1;

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
        const place = getPlaceByUrl(request.query.url ?? "");
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
        const place = getPlaceById(request.params.id);
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
};
