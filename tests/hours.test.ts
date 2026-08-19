import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createKey, DEFAULT_FREE_CREDITS } from "../src/billing/keys.js";
import { PlaceError } from "../src/core/errors.js";
import {
  assertValidHours,
  getHoursByPlaceId,
  getHoursBySlug,
  intervalWrapsMidnight,
  listHoursSlugs,
} from "../src/core/hours.js";
import { getPlaceById, loadPlaceFixtures, placeIdFromCanonical } from "../src/core/place.js";
import { openDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { ErrorCode, Hours } from "../src/types.js";

const TEST_KEY = "lk_test_hours";
const FRANKLIN =
  "https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001";
const BLUE_BOTTLE =
  "https://www.google.com/maps/place/Blue+Bottle+Coffee/@37.7763,-122.4232,17z";
const BREWDOG =
  "https://www.google.com/maps/place/BrewDog+Soho/@51.5139,-0.1346,17z";

function franklinId(): string {
  return placeIdFromCanonical(FRANKLIN);
}

function assertHoursShape(hours: Hours): void {
  assert.ok(hours.timezone === null || hours.timezone.length > 0);
  assert.ok(hours.note === null || typeof hours.note === "string");
  for (const row of hours.weekly) {
    assert.ok(Number.isInteger(row.day) && row.day >= 0 && row.day <= 6);
    assert.equal(intervalWrapsMidnight(row.open, row.close), false);
  }
}

test("hours catalog covers every fixture slug and never wraps midnight", () => {
  const slugs = new Set(listHoursSlugs());
  const fixtures = loadPlaceFixtures();
  assert.equal(slugs.size, fixtures.length);
  for (const fixture of fixtures) {
    assert.ok(slugs.has(fixture.slug), fixture.slug);
    const hours = getHoursBySlug(fixture.slug);
    if (hours !== null) {
      assertHoursShape(hours);
    }
  }
  assert.equal(getHoursBySlug("blue-bottle-mint-sf"), null);
});

test("overnight hours are two intervals, not one past 24:00", () => {
  const hours = getHoursBySlug("brewdog-soho");
  assert.ok(hours);
  const friday = hours.weekly.filter((row) => row.day === 5);
  const saturday = hours.weekly.filter((row) => row.day === 6);
  assert.ok(friday.some((row) => row.close === "24:00"));
  assert.ok(saturday.some((row) => row.open === "00:00" && row.close === "01:00"));
  assert.equal(
    hours.weekly.some((row) => intervalWrapsMidnight(row.open, row.close)),
    false,
  );
  assert.equal(intervalWrapsMidnight("22:00", "01:00"), true);
  assert.equal(intervalWrapsMidnight("11:00", "15:00"), false);
  assert.throws(
    () =>
      assertValidHours({
        timezone: "Europe/London",
        weekly: [{ day: 5, open: "22:00", close: "01:00" }],
        note: null,
      }),
    /wraps past 24:00/,
  );
});

test("place card hours match GET hours subset", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  for (const fixture of loadPlaceFixtures()) {
    const id = placeIdFromCanonical(fixture.mapsUrl);
    const card = getPlaceById(id, now);
    const hours = getHoursByPlaceId(id);
    assert.deepEqual(card.hours, hours);
  }
  assert.equal(getHoursByPlaceId(placeIdFromCanonical(BLUE_BOTTLE)), null);
  const franklin = getHoursByPlaceId(franklinId());
  assert.ok(franklin);
  assert.equal(franklin.timezone, "America/Chicago");
  assert.equal(
    franklin.weekly.some((row) => row.day === 1),
    false,
  );
});

test("unknown place id is place_not_found", () => {
  try {
    getHoursByPlaceId("plc_notreal");
    assert.fail("expected place_not_found");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "place_not_found");
  }
});

test("GET /v1/places/{id}/hours returns the card subset and charges 1", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/hours`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Hours;
    meta: { creditsCharged: number; requestId: string };
  };
  assert.equal(body.data.timezone, "America/Chicago");
  assertHoursShape(body.data);
  assert.equal(body.meta.creditsCharged, 1);
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

test("GET hours null fixture is 200 null data and still 1 credit", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/${placeIdFromCanonical(BLUE_BOTTLE)}/hours`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Hours | null; meta: { creditsCharged: number } };
  assert.equal(body.data, null);
  assert.equal(body.meta.creditsCharged, 1);

  const overnight = await app.inject({
    method: "GET",
    url: `/v1/places/${placeIdFromCanonical(BREWDOG)}/hours`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(overnight.statusCode, 200);
  const brew = (overnight.json() as { data: Hours }).data;
  assert.ok(brew.weekly.some((row) => row.day === 5 && row.close === "24:00"));
  assert.ok(brew.weekly.some((row) => row.day === 6 && row.open === "00:00"));
});

test("GET hours unknown id / no auth charge 0", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const missing = await app.inject({
    method: "GET",
    url: "/v1/places/plc_notreal/hours",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(missing.statusCode, 404);
  const missingBody = missing.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(missingBody.error.code, "place_not_found");
  assert.equal(missingBody.meta.creditsCharged, 0);

  const unauth = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/hours`,
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("zero-credit key is 402 on hours", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "lk_test_broke_hours", credits: 0 });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/hours`,
    headers: { authorization: "Bearer lk_test_broke_hours" },
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});
