import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createKey, DEFAULT_FREE_CREDITS } from "../src/billing/keys.js";
import { PlaceError } from "../src/core/errors.js";
import {
  getPlaceById,
  getPlaceByUrl,
  isMapsPlaceUrl,
  isUsOrUkLatLng,
  loadPlaceFixtures,
  PLACE_FIXTURE_COUNT,
  placeIdFromCanonical,
} from "../src/core/place.js";
import { openDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { ErrorCode, Place } from "../src/types.js";

const TEST_KEY = "lk_test_places_by_url";

const FRANKLIN =
  "https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001";
const FRANKLIN_SHORT = "https://maps.app.goo.gl/franklinbbq";
const FRANKLIN_WWW_VARIANT =
  "http://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001?utm_source=share&hl=en";
const JOE_CID = "https://maps.google.com/?cid=1000000000000000007";
const DISHOOM =
  "https://www.google.com/maps/place/Dishoom+Covent+Garden/@51.5124,-0.1269,17z";
const PARIS_CAFE =
  "https://www.google.com/maps/place/Café+de+Flore/@48.8540,2.3326,17z";
const TOKYO_RAMEN =
  "https://www.google.com/maps/place/Ichiran+Shibuya/@35.6595,139.7005,17z";
const UNKNOWN_US =
  "https://www.google.com/maps/place/Not+A+Real+Diner/@30.2672,-97.7431,17z";
const SEARCH_URL = "https://www.google.com/maps/search/coffee/@30.2672,-97.7431,14z";
const DIR_URL =
  "https://www.google.com/maps/dir/Austin+TX/Houston+TX/@30.1,-97.5,8z";
const NOT_MAPS = "https://example.com/places/franklin";

function assertPlaceCard(place: Place): void {
  assert.match(place.id, /^plc_[a-z2-7]+$/);
  assert.ok(place.name.length > 0);
  assert.ok(place.address.formatted.length > 0);
  assert.ok(place.address.country === "US" || place.address.country === "GB");
  assert.equal(place.hours, null);
  assert.ok(Array.isArray(place.categories));
  assert.match(place.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(place.mapsUrl.startsWith("http"));
}

test("fixture catalog is 30 US/UK restaurants and shops", () => {
  const fixtures = loadPlaceFixtures();
  assert.equal(fixtures.length, PLACE_FIXTURE_COUNT);
  const countries = new Set(fixtures.map((row) => row.address.country));
  assert.deepEqual([...countries].sort(), ["GB", "US"]);
  assert.ok(fixtures.some((row) => row.address.country === "US"));
  assert.ok(fixtures.some((row) => row.address.country === "GB"));
  assert.ok(fixtures.every((row) => row.name.length > 0 && row.address.formatted.length > 0));
  const ids = fixtures.map((row) => placeIdFromCanonical(row.mapsUrl));
  assert.equal(new Set(ids).size, PLACE_FIXTURE_COUNT);
  assert.ok(ids.every((id) => /^plc_[a-z2-7]+$/.test(id)));
});

test("isMapsPlaceUrl accepts maps.google.com, google.com/maps, maps.app.goo.gl", () => {
  assert.equal(isMapsPlaceUrl(FRANKLIN), true);
  assert.equal(isMapsPlaceUrl(FRANKLIN_SHORT), true);
  assert.equal(isMapsPlaceUrl(JOE_CID), true);
  assert.equal(isMapsPlaceUrl(DISHOOM), true);
  assert.equal(isMapsPlaceUrl("https://maps.google.com/maps/place/la+barbecue/@30.2568,-97.7221,17z"), true);
  assert.equal(isMapsPlaceUrl(SEARCH_URL), false);
  assert.equal(isMapsPlaceUrl(DIR_URL), false);
  assert.equal(isMapsPlaceUrl(NOT_MAPS), false);
  assert.equal(isMapsPlaceUrl("not-a-url"), false);
  assert.equal(isMapsPlaceUrl("https://news.ycombinator.com"), false);
});

test("same Maps URL always hashes to the same plc_ id", () => {
  const a = placeIdFromCanonical(FRANKLIN);
  const b = placeIdFromCanonical(FRANKLIN);
  const c = placeIdFromCanonical(FRANKLIN_WWW_VARIANT);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, placeIdFromCanonical(DISHOOM));
});

test("SPEC 1: every fixture URL returns name + formatted address", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  for (const fixture of loadPlaceFixtures()) {
    const place = getPlaceByUrl(fixture.mapsUrl, now);
    assertPlaceCard(place);
    assert.equal(place.name, fixture.name);
    assert.equal(place.address.formatted, fixture.address.formatted);
    assert.equal(place.id, placeIdFromCanonical(fixture.mapsUrl));
    const again = getPlaceById(place.id, now);
    assert.equal(again.id, place.id);
    assert.equal(again.name, fixture.name);
    if (fixture.shortUrl !== undefined) {
      const viaShort = getPlaceByUrl(fixture.shortUrl, now);
      assert.equal(viaShort.id, place.id);
    }
  }
});

test("by-url resolves www, query junk, and short links to the same place", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const a = getPlaceByUrl(FRANKLIN, now);
  const b = getPlaceByUrl(FRANKLIN_WWW_VARIANT, now);
  const c = getPlaceByUrl(FRANKLIN_SHORT, now);
  assert.equal(a.name, "Franklin Barbecue");
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  assert.equal(a.address.formatted, "900 E 11th St, Austin, TX 78702, USA");
});

test("SPEC 5: non US/UK Maps place URL is region_unsupported", () => {
  assert.equal(isUsOrUkLatLng(48.854, 2.3326), false);
  assert.equal(isUsOrUkLatLng(35.6595, 139.7005), false);
  assert.equal(isUsOrUkLatLng(30.2672, -97.7431), true);
  assert.equal(isUsOrUkLatLng(51.5074, -0.1278), true);

  for (const url of [PARIS_CAFE, TOKYO_RAMEN]) {
    try {
      getPlaceByUrl(url);
      assert.fail(`expected region_unsupported for ${url}`);
    } catch (err) {
      assert.ok(err instanceof PlaceError);
      assert.equal(err.code, "region_unsupported");
    }
  }
});

test("unknown US/UK place URL is place_not_found; garbage is invalid_place_url", () => {
  try {
    getPlaceByUrl(UNKNOWN_US);
    assert.fail("expected place_not_found");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "place_not_found");
  }
  try {
    getPlaceByUrl(SEARCH_URL);
    assert.fail("expected invalid_place_url");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "invalid_place_url");
  }
  try {
    getPlaceByUrl(NOT_MAPS);
    assert.fail("expected invalid_place_url");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "invalid_place_url");
  }
  try {
    getPlaceByUrl("");
    assert.fail("expected invalid_request");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "invalid_request");
  }
  try {
    getPlaceById("plc_doesnotexist");
    assert.fail("expected place_not_found");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "place_not_found");
  }
});

test("GET /v1/places/by-url fixture → 200 name + address, 1 credit", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(FRANKLIN)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Place;
    meta: { creditsCharged: number; cached: boolean; requestId: string; upstreamMs: number };
  };
  assertPlaceCard(body.data);
  assert.equal(body.data.name, "Franklin Barbecue");
  assert.equal(body.data.address.formatted, "900 E 11th St, Austin, TX 78702, USA");
  assert.equal(body.data.hours, null);
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(body.meta.cached, false);
  assert.match(body.meta.requestId, /^req_/);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining,
    DEFAULT_FREE_CREDITS - 1,
  );
});

test("GET /v1/places/{id} returns the same card as by-url", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const byUrl = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(DISHOOM)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(byUrl.statusCode, 200);
  const first = byUrl.json() as { data: Place; meta: { creditsCharged: number } };
  assert.equal(first.data.name, "Dishoom Covent Garden");
  assert.equal(first.data.address.country, "GB");
  assert.equal(first.meta.creditsCharged, 1);

  const byId = await app.inject({
    method: "GET",
    url: `/v1/places/${first.data.id}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(byId.statusCode, 200);
  const second = byId.json() as { data: Place; meta: { creditsCharged: number } };
  assert.equal(second.data.id, first.data.id);
  assert.equal(second.data.name, first.data.name);
  assert.equal(second.data.address.formatted, first.data.address.formatted);
  assert.equal(second.meta.creditsCharged, 1);
});

test("GET /v1/places/by-url all 30 fixtures return 200", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  for (const fixture of loadPlaceFixtures()) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/places/by-url?url=${encodeURIComponent(fixture.mapsUrl)}`,
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    assert.equal(response.statusCode, 200, fixture.slug);
    const body = response.json() as { data: Place; meta: { creditsCharged: number } };
    assert.equal(body.data.name, fixture.name, fixture.slug);
    assert.equal(body.data.address.formatted, fixture.address.formatted, fixture.slug);
    assert.equal(body.meta.creditsCharged, 1, fixture.slug);
  }
});

test("SPEC 5 HTTP: non US/UK URL is 422 region_unsupported and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(PARIS_CAFE)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 422);
  const body = response.json() as {
    error: { code: ErrorCode; retryable: boolean };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "region_unsupported");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining,
    DEFAULT_FREE_CREDITS,
  );
});

test("invalid Maps URL is 400 invalid_place_url with 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  for (const url of [SEARCH_URL, DIR_URL, NOT_MAPS, "not-a-url"]) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/places/by-url?url=${encodeURIComponent(url)}`,
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    assert.equal(response.statusCode, 400, url);
    const body = response.json() as {
      error: { code: ErrorCode };
      meta: { creditsCharged: number };
    };
    assert.equal(body.error.code, "invalid_place_url");
    assert.equal(body.meta.creditsCharged, 0);
  }
});

test("unknown fixture place is 404 place_not_found with 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(UNKNOWN_US)}`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "place_not_found");
  assert.equal(body.meta.creditsCharged, 0);

  const missingId = await app.inject({
    method: "GET",
    url: "/v1/places/plc_notreal",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(missingId.statusCode, 404);
  assert.equal((missingId.json() as { error: { code: string } }).error.code, "place_not_found");
  assert.equal((missingId.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("missing url query is 400 invalid_request with 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/places/by-url",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.meta.creditsCharged, 0);
});

test("GET /v1/places/by-url without bearer is 401 with 0 credits", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(FRANKLIN)}`,
  });
  assert.equal(response.statusCode, 401);
  const body = response.json() as {
    error: { code: string };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("zero-credit key is 402 and does not look up as a success", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "lk_test_broke", credits: 0 });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(FRANKLIN)}`,
    headers: { authorization: "Bearer lk_test_broke" },
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});
