import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createAppAdapter,
  createFixtureAdapter,
  createLiveMapsAdapter,
  isLiveMapsEnabled,
  type LiveFetch,
} from "../src/adapters/index.js";
import { createLiveMapsAdapter as createLiveFromModule } from "../src/adapters/maps/live.js";
import {
  extractGooglePlaceId,
  hoursFromGooglePlace,
  parseSearchResponse,
  placeFromGooglePlace,
  reviewsFromGooglePlace,
  type GooglePlace,
} from "../src/adapters/maps/parse.js";
import { buildApp } from "../src/app.js";
import { createKey, DEFAULT_FREE_CREDITS } from "../src/billing/keys.js";
import { PlaceError } from "../src/core/errors.js";
import { createMemoryPlaceIndex } from "../src/core/place-index.js";
import { placeIdFromCanonical } from "../src/core/place.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Place } from "../src/types.js";

const FRANKLIN =
  "https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001";
const FRANKLIN_SHORT = "https://maps.app.goo.gl/franklinbbq";
const FRANKLIN_VARIANT =
  "http://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001?utm_source=share&hl=en";
const PARIS_CAFE =
  "https://www.google.com/maps/place/Café+de+Flore/@48.8540,2.3326,17z";
const SEARCH_URL = "https://www.google.com/maps/search/coffee/@30.2672,-97.7431,14z";
const VENDOR_ID = "ChIJTestFranklinBbqAustin0001";
const NOW = new Date("2026-08-20T12:00:00.000Z");

const FRANKLIN_GOOGLE: GooglePlace = {
  id: VENDOR_ID,
  displayName: { text: "Franklin Barbecue" },
  formattedAddress: "900 E 11th St, Austin, TX 78702, USA",
  addressComponents: [
    { longText: "900", types: ["street_number"] },
    { longText: "E 11th St", types: ["route"] },
    { longText: "Austin", types: ["locality"] },
    { shortText: "TX", types: ["administrative_area_level_1"] },
    { longText: "78702", types: ["postal_code"] },
    { shortText: "US", types: ["country"] },
  ],
  location: { latitude: 30.27013, longitude: -97.73132 },
  nationalPhoneNumber: "+1 512-653-1187",
  websiteUri: "https://franklinbbq.com",
  rating: 4.7,
  userRatingCount: 12840,
  regularOpeningHours: {
    periods: [
      { open: { day: 0, hour: 11, minute: 0 }, close: { day: 0, hour: 15, minute: 0 } },
      { open: { day: 2, hour: 11, minute: 0 }, close: { day: 2, hour: 15, minute: 0 } },
    ],
  },
  types: ["barbecue_restaurant", "restaurant"],
  googleMapsUri: FRANKLIN,
  timeZone: { id: "America/Chicago" },
  reviews: [
    {
      name: "places/ChIJTest/reviews/revA",
      rating: 5,
      text: { text: "Brisket was worth the wait.", languageCode: "en" },
      publishTime: "2026-03-12T15:02:00.000Z",
      authorAttribution: { displayName: "Maya T." },
    },
    {
      name: "places/ChIJTest/reviews/revB",
      rating: 4,
      originalText: { text: "Line moved. Sides were fine.", languageCode: "en" },
      publishTime: "2026-02-01T18:40:00.000Z",
    },
    {
      rating: 2,
      text: { text: "" },
    },
  ],
};

function recordedFetch(handlers: {
  get?: GooglePlace | { status: number };
  search?: unknown | { status: number };
  shorts?: Record<string, string>;
}): LiveFetch {
  return async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "maps.app.goo.gl" || url.hostname === "goo.gl") {
      const dest = handlers.shorts?.[url.toString()];
      if (dest === undefined) {
        throw new Error(`unexpected short URL ${input}`);
      }
      return {
        status: 200,
        url: dest,
        json: async () => ({}),
      };
    }
    if (url.hostname !== "places.googleapis.com") {
      throw new Error(`live adapter must not call ${url.hostname}`);
    }
    if (url.pathname.endsWith(":searchText")) {
      const payload = handlers.search ?? { places: [] };
      if (isStatus(payload)) {
        return { status: payload.status, url: input, json: async () => ({}) };
      }
      return { status: 200, url: input, json: async () => payload };
    }
    if (url.pathname.startsWith("/v1/places/")) {
      const payload = handlers.get ?? FRANKLIN_GOOGLE;
      if (isStatus(payload)) {
        return { status: payload.status, url: input, json: async () => ({}) };
      }
      return { status: 200, url: input, json: async () => payload };
    }
    throw new Error(`unexpected live request ${init?.method ?? "GET"} ${input}`);
  };
}

function isStatus(value: unknown): value is { status: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof (value as { status: unknown }).status === "number" &&
    !("id" in value) &&
    !("places" in value)
  );
}

test("createAppAdapter defaults to fixture and ignores a Maps key", () => {
  const adapter = createAppAdapter({
    env: { LOCALAPI_MAPS_API_KEY: "should-not-matter" },
  });
  assert.equal(adapter.kind, "fixture");
  assert.equal(isLiveMapsEnabled({}), false);
  assert.equal(isLiveMapsEnabled({ LOCALAPI_LIVE: "0" }), false);
  assert.equal(isLiveMapsEnabled({ LOCALAPI_LIVE: "1" }), true);
  assert.throws(
    () => createAppAdapter({ env: { LOCALAPI_LIVE: "1" } }),
    /LOCALAPI_MAPS_API_KEY is required/,
  );
  const live = createAppAdapter({
    env: { LOCALAPI_LIVE: "1", LOCALAPI_MAPS_API_KEY: "test-places-key" },
  });
  assert.equal(live.kind, "live");
});

test("fixture adapter still serves the 30-place catalog", async () => {
  const adapter = createFixtureAdapter();
  const place = await adapter.getPlaceByUrl(FRANKLIN, NOW);
  assert.equal(place.name, "Franklin Barbecue");
  assert.equal(place.id, placeIdFromCanonical(FRANKLIN));
  assert.equal(place.id, placeIdFromCanonical(FRANKLIN_VARIANT));
  const viaShort = await adapter.getPlaceByUrl(FRANKLIN_SHORT, NOW);
  assert.equal(viaShort.id, place.id);
});

test("same Maps URL always hashes to the same plc_ through the live parser", () => {
  const a = placeIdFromCanonical(FRANKLIN);
  const b = placeIdFromCanonical(FRANKLIN_VARIANT);
  const parsed = placeFromGooglePlace(FRANKLIN_GOOGLE, FRANKLIN, NOW);
  assert.equal(a, b);
  assert.equal(parsed.id, a);
  assert.match(parsed.id, /^plc_[a-z2-7]+$/);
});

test("live parser maps hours, reviews, and never invents a review", () => {
  const hours = hoursFromGooglePlace(FRANKLIN_GOOGLE);
  assert.ok(hours);
  assert.equal(hours.timezone, "America/Chicago");
  assert.ok(hours.weekly.every((row) => row.open === "11:00" && row.close === "15:00"));

  const reviews = reviewsFromGooglePlace(FRANKLIN_GOOGLE);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0]?.id, "revA");
  assert.equal(reviews[0]?.stars, 5);
  assert.equal(reviews[0]?.text, "Brisket was worth the wait.");
  assert.equal(reviews[1]?.id, "revB");
  assert.equal(
    reviewsFromGooglePlace({ reviews: [{ rating: 5, text: { text: "   " } }] }).length,
    0,
  );
});

test("live parser drops places outside US/UK and search hits without a Maps URL", () => {
  assert.throws(
    () =>
      placeFromGooglePlace(
        {
          displayName: { text: "Café de Flore" },
          formattedAddress: "172 Bd Saint-Germain, 75006 Paris, France",
          addressComponents: [{ shortText: "FR", types: ["country"] }],
          location: { latitude: 48.854, longitude: 2.3326 },
          googleMapsUri: PARIS_CAFE,
        },
        PARIS_CAFE,
        NOW,
      ),
    (err: unknown) => err instanceof PlaceError && err.code === "region_unsupported",
  );
  assert.deepEqual(
    parseSearchResponse({
      places: [
        { displayName: { text: "No URL" }, formattedAddress: "Austin, TX" },
        FRANKLIN_GOOGLE,
      ],
    }).map((row) => row.hit.name),
    ["Franklin Barbecue"],
  );
});

test("extractGooglePlaceId reads place_id query and !1s data blobs", () => {
  assert.equal(
    extractGooglePlaceId(
      new URL(`https://www.google.com/maps/place/Franklin/?query_place_id=${VENDOR_ID}`),
    ),
    VENDOR_ID,
  );
  assert.equal(
    extractGooglePlaceId(
      new URL(`https://www.google.com/maps/place/Franklin/data=!3m1!1s${VENDOR_ID}`),
    ),
    VENDOR_ID,
  );
});

test("live adapter resolves a recorded Places payload and stores plc_ without inventing ids", async () => {
  const index = createMemoryPlaceIndex();
  const adapter = createLiveMapsAdapter({
    apiKey: "test-key",
    placeIndex: index,
    now: () => NOW,
    fetchImpl: recordedFetch({ get: FRANKLIN_GOOGLE }),
  });
  const url = `https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z?query_place_id=${VENDOR_ID}`;
  const place = await adapter.getPlaceByUrl(url, NOW);
  assert.equal(place.name, "Franklin Barbecue");
  assert.equal(place.address.formatted, "900 E 11th St, Austin, TX 78702, USA");
  assert.equal(place.address.country, "US");
  assert.equal(place.id, placeIdFromCanonical(url));
  assert.equal(index.getById(place.id)?.vendorPlaceId, VENDOR_ID);

  const again = await adapter.getPlaceById(place.id, NOW);
  assert.equal(again.id, place.id);
  assert.equal(again.name, place.name);

  const reviews = await adapter.getReviewPage(place.id);
  assert.equal(reviews.reviews.length, 2);
  assert.equal(reviews.hasMore, false);
  assert.ok(reviews.reviews.every((row) => row.text.length > 0));

  const hours = await adapter.getHoursByPlaceId(place.id);
  assert.ok(hours);
  assert.equal(hours.timezone, "America/Chicago");
});

test("live adapter follows a short URL then uses the recorded Places body", async () => {
  const adapter = createLiveMapsAdapter({
    apiKey: "test-key",
    now: () => NOW,
    fetchImpl: recordedFetch({
      shorts: { [FRANKLIN_SHORT]: `${FRANKLIN}?query_place_id=${VENDOR_ID}` },
      get: FRANKLIN_GOOGLE,
    }),
  });
  const place = await adapter.getPlaceByUrl(FRANKLIN_SHORT, NOW);
  assert.equal(place.name, "Franklin Barbecue");
  assert.equal(place.id, placeIdFromCanonical(FRANKLIN_SHORT));
});

test("live adapter maps SPEC failures and never charges in HTTP", async () => {
  const blocked = createLiveMapsAdapter({
    apiKey: "test-key",
    fetchImpl: recordedFetch({ get: { status: 403 } }),
  });
  await assert.rejects(
    () =>
      blocked.getPlaceByUrl(
        `https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z?query_place_id=${VENDOR_ID}`,
      ),
    (err: unknown) => err instanceof PlaceError && err.code === "upstream_blocked",
  );

  const missing = createLiveMapsAdapter({
    apiKey: "test-key",
    fetchImpl: recordedFetch({ get: { status: 404 } }),
  });
  await assert.rejects(
    () =>
      missing.getPlaceByUrl(
        `https://www.google.com/maps/place/Not+A+Diner/@30.2672,-97.7431,17z?query_place_id=${VENDOR_ID}`,
      ),
    (err: unknown) => err instanceof PlaceError && err.code === "place_not_found",
  );

  const live = createLiveMapsAdapter({
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("network must not be used for this case");
    },
  });
  await assert.rejects(
    () => live.getPlaceByUrl(PARIS_CAFE),
    (err: unknown) => err instanceof PlaceError && err.code === "region_unsupported",
  );
  await assert.rejects(
    () => live.getPlaceByUrl(SEARCH_URL),
    (err: unknown) => err instanceof PlaceError && err.code === "invalid_place_url",
  );
  await assert.rejects(
    () => live.getPlaceById("plc_never_seen"),
    (err: unknown) => err instanceof PlaceError && err.code === "place_not_found",
  );
});

test("live search records plc_ from googleMapsUri and skips extra-region hits", async () => {
  const adapter = createLiveMapsAdapter({
    apiKey: "test-key",
    fetchImpl: recordedFetch({
      search: {
        places: [
          FRANKLIN_GOOGLE,
          {
            displayName: { text: "Café de Flore" },
            formattedAddress: "Paris, France",
            addressComponents: [{ shortText: "FR", types: ["country"] }],
            googleMapsUri: PARIS_CAFE,
          },
        ],
      },
    }),
  });
  const page = await adapter.searchPlaces({ q: "barbecue", city: "Austin" });
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0]?.name, "Franklin Barbecue");
  assert.equal(page.results[0]?.id, placeIdFromCanonical(FRANKLIN));
});

test("GET /v1/places/by-url with injected live adapter charges 1 on success and 0 on SPEC errors", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "lk_test_live_maps", credits: DEFAULT_FREE_CREDITS });
  const adapter = createLiveMapsAdapter({
    apiKey: "test-key",
    now: () => NOW,
    fetchImpl: recordedFetch({ get: FRANKLIN_GOOGLE }),
  });
  const app = await buildApp({ db, adapter });
  after(() => app.close());

  const url = `https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z?query_place_id=${VENDOR_ID}`;
  const ok = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(url)}`,
    headers: { authorization: "Bearer lk_test_live_maps" },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as { data: Place; meta: { creditsCharged: number } };
  assert.equal(body.data.name, "Franklin Barbecue");
  assert.equal(body.meta.creditsCharged, 1);

  const blockedAdapter = createLiveFromModule({
    apiKey: "test-key",
    fetchImpl: recordedFetch({ get: { status: 429 } }),
  });
  const blockedApp = await buildApp({ db, adapter: blockedAdapter });
  after(() => blockedApp.close());
  const blocked = await blockedApp.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(url)}`,
    headers: { authorization: "Bearer lk_test_live_maps" },
  });
  assert.equal(blocked.statusCode, 503);
  const err = blocked.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(err.error.code, "upstream_blocked");
  assert.equal(err.meta.creditsCharged, 0);
});
