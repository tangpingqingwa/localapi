import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createKey, DEFAULT_FREE_CREDITS } from "../src/billing/keys.js";
import { PlaceError } from "../src/core/errors.js";
import { loadPlaceFixtures, placeIdFromCanonical } from "../src/core/place.js";
import {
  getReviewPage,
  loadReviewFixtures,
  parseReviewPage,
  REVIEWS_PAGE_SIZE,
} from "../src/core/reviews.js";
import { openDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { ErrorCode, Review, ReviewPage } from "../src/types.js";

const TEST_KEY = "lk_test_reviews";
const FRANKLIN =
  "https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001";
const DISHOOM =
  "https://www.google.com/maps/place/Dishoom+Covent+Garden/@51.5124,-0.1269,17z";
const BLUE_BOTTLE =
  "https://www.google.com/maps/place/Blue+Bottle+Coffee/@37.7763,-122.4232,17z";

function franklinId(): string {
  return placeIdFromCanonical(FRANKLIN);
}

function dishoomId(): string {
  return placeIdFromCanonical(DISHOOM);
}

function blueBottleId(): string {
  return placeIdFromCanonical(BLUE_BOTTLE);
}

function assertReviewShape(review: Review): void {
  assert.ok(review.id === null || typeof review.id === "string");
  assert.ok(review.author === null || typeof review.author === "string");
  assert.ok(Number.isInteger(review.stars) && review.stars >= 1 && review.stars <= 5);
  assert.equal(typeof review.text, "string");
  assert.ok(review.text.length > 0);
  assert.ok(review.createdAt === null || typeof review.createdAt === "string");
  assert.ok(review.language === null || typeof review.language === "string");
}

test("every fixture place has a reviews catalog entry (stars + text or empty)", () => {
  const catalog = loadReviewFixtures();
  const fixtures = loadPlaceFixtures();
  assert.equal(catalog.size, fixtures.length);
  for (const fixture of fixtures) {
    const reviews = catalog.get(fixture.slug);
    assert.ok(reviews !== undefined, fixture.slug);
    for (const review of reviews) {
      assertReviewShape(review);
    }
  }
  assert.deepEqual(catalog.get("blue-bottle-mint-sf"), []);
  assert.ok((catalog.get("franklin-bbq-austin")?.length ?? 0) > REVIEWS_PAGE_SIZE);
});

test("SPEC 2: reviews page 1 is stars + text or empty", () => {
  for (const fixture of loadPlaceFixtures()) {
    const page = getReviewPage(placeIdFromCanonical(fixture.mapsUrl), { page: 1 });
    assert.equal(page.page, 1);
    assert.equal(page.language, null);
    assert.equal(typeof page.hasMore, "boolean");
    if (page.reviews.length === 0) {
      assert.equal(page.hasMore, false);
      continue;
    }
    for (const review of page.reviews) {
      assertReviewShape(review);
    }
  }
});

test("Franklin page 1 hasMore; page 2 continues; past end is empty 200 shape", () => {
  const id = franklinId();
  const first = getReviewPage(id);
  assert.equal(first.page, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.reviews.length, REVIEWS_PAGE_SIZE);
  assert.equal(first.reviews[0]?.text.includes("Brisket"), true);

  const second = getReviewPage(id, { page: 2 });
  assert.equal(second.page, 2);
  assert.ok(second.reviews.length >= 1);
  assert.equal(second.hasMore, false);
  assert.notEqual(second.reviews[0]?.id, first.reviews[0]?.id);

  const past = getReviewPage(id, { page: 9 });
  assert.equal(past.page, 9);
  assert.deepEqual(past.reviews, []);
  assert.equal(past.hasMore, false);
});

test("lang filters to matching reviews; empty language set is empty page", () => {
  const id = dishoomId();
  const en = getReviewPage(id, { lang: "en" });
  assert.equal(en.language, "en");
  assert.ok(en.reviews.length >= 1);
  assert.ok(en.reviews.every((row) => row.language === "en"));

  const fr = getReviewPage(id, { lang: "fr" });
  assert.equal(fr.language, "fr");
  assert.equal(fr.reviews.length, 1);
  assert.match(fr.reviews[0]?.text ?? "", /chai/i);

  const none = getReviewPage(id, { lang: "es" });
  assert.equal(none.language, "es");
  assert.deepEqual(none.reviews, []);
  assert.equal(none.hasMore, false);
});

test("unknown place is place_not_found; bad page is invalid_request", () => {
  try {
    getReviewPage("plc_notreal");
    assert.fail("expected place_not_found");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "place_not_found");
  }
  try {
    getReviewPage(franklinId(), { page: 0 });
    assert.fail("expected invalid_request");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "invalid_request");
  }
  assert.equal(parseReviewPage(undefined), 1);
  assert.equal(parseReviewPage(""), 1);
  assert.equal(parseReviewPage("2"), 2);
  assert.equal(parseReviewPage("0"), null);
  assert.equal(parseReviewPage("1.5"), null);
  assert.equal(parseReviewPage("-1"), null);
});

test("GET /v1/places/{id}/reviews page 1 charges 1 credit (SPEC 2)", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/reviews`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: ReviewPage;
    meta: { creditsCharged: number; cached: boolean; requestId: string };
  };
  assert.equal(body.data.page, 1);
  assert.equal(body.data.hasMore, true);
  assert.ok(body.data.reviews.length >= 1);
  for (const review of body.data.reviews) {
    assertReviewShape(review);
  }
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

test("GET reviews empty catalog is 200 with empty array and still 1 credit", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/${blueBottleId()}/reviews`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: ReviewPage; meta: { creditsCharged: number } };
  assert.deepEqual(body.data.reviews, []);
  assert.equal(body.data.hasMore, false);
  assert.equal(body.meta.creditsCharged, 1);
});

test("GET reviews unknown id / bad page / no auth charge 0", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const missing = await app.inject({
    method: "GET",
    url: "/v1/places/plc_notreal/reviews",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(missing.statusCode, 404);
  const missingBody = missing.json() as {
    error: { code: ErrorCode };
    meta: { creditsCharged: number };
  };
  assert.equal(missingBody.error.code, "place_not_found");
  assert.equal(missingBody.meta.creditsCharged, 0);

  const badPage = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/reviews?page=0`,
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(badPage.statusCode, 400);
  assert.equal((badPage.json() as { error: { code: string } }).error.code, "invalid_request");
  assert.equal((badPage.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);

  const unauth = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/reviews`,
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as { error: { code: string } }).error.code, "unauthorized");
  assert.equal((unauth.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("zero-credit key is 402 on reviews and does not invent a page", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "lk_test_broke_reviews", credits: 0 });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/places/${franklinId()}/reviews`,
    headers: { authorization: "Bearer lk_test_broke_reviews" },
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});
