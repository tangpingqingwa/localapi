import assert from "node:assert/strict";
import { after, test } from "node:test";
import { tryCharge } from "../src/billing/charge.js";
import {
  createKey,
  dailyRemaining,
  DEFAULT_FREE_CREDITS,
  DEFAULT_FREE_DAILY_CAP,
} from "../src/billing/keys.js";
import { PlaceError } from "../src/core/errors.js";
import { loadPlaceFixtures, placeIdFromCanonical } from "../src/core/place.js";
import {
  DOCUMENTED_EMPTY_COFFEE_AUSTIN,
  parseBbox,
  parseSearchLimit,
  SEARCH_LIMIT_MAX,
  SEARCH_MIN_CREDITS,
  searchCredits,
  searchPlaces,
} from "../src/core/search.js";
import { openDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { ErrorCode, SearchHit, SearchPage } from "../src/types.js";

const TEST_KEY = "lk_test_search";

function assertHit(hit: SearchHit): void {
  assert.match(hit.id, /^plc_[a-z2-7]+$/);
  assert.ok(hit.name.length > 0);
  assert.ok(hit.address.formatted.length > 0);
  assert.ok(hit.address.country === "US" || hit.address.country === "GB");
  assert.ok(Array.isArray(hit.categories));
  assert.ok(hit.mapsUrl.startsWith("http"));
}

test("searchCredits is max(3, n) when any result, else 0", () => {
  assert.equal(searchCredits(0), 0);
  assert.equal(searchCredits(1), SEARCH_MIN_CREDITS);
  assert.equal(searchCredits(2), SEARCH_MIN_CREDITS);
  assert.equal(searchCredits(3), 3);
  assert.equal(searchCredits(7), 7);
  assert.throws(() => searchCredits(-1), /non-negative/);
});

test("parseSearchLimit defaults, caps at 20, rejects junk", () => {
  assert.equal(parseSearchLimit(undefined), SEARCH_LIMIT_MAX);
  assert.equal(parseSearchLimit(""), SEARCH_LIMIT_MAX);
  assert.equal(parseSearchLimit("5"), 5);
  assert.equal(parseSearchLimit(99), SEARCH_LIMIT_MAX);
  assert.equal(parseSearchLimit("0"), null);
  assert.equal(parseSearchLimit("1.5"), null);
  assert.equal(parseSearchLimit(-2), null);
});

test("parseBbox reads west,south,east,north", () => {
  assert.equal(parseBbox(undefined), undefined);
  assert.equal(parseBbox(""), undefined);
  assert.deepEqual(parseBbox("-97.76,30.24,-97.72,30.28"), {
    west: -97.76,
    south: 30.24,
    east: -97.72,
    north: 30.28,
  });
  assert.equal(parseBbox("not-a-box"), null);
  assert.equal(parseBbox("1,2,3"), null);
});

test("SPEC 3: coffee + Austin is documented empty (no Austin coffee in fixtures)", () => {
  const austinCoffee = loadPlaceFixtures().filter(
    (row) =>
      row.address.city === "Austin" &&
      (row.categories.some((cat) => /coffee/i.test(cat)) || /coffee/i.test(row.name)),
  );
  assert.deepEqual(austinCoffee, []);

  const page = searchPlaces(DOCUMENTED_EMPTY_COFFEE_AUSTIN);
  assert.deepEqual(page.results, []);
  assert.equal(page.query.q, "coffee");
  assert.equal(page.query.city, "Austin");
  assert.equal(searchCredits(page.results.length), 0);
});

test("city listing returns ≥3 Austin fixtures", () => {
  const page = searchPlaces({ city: "Austin" });
  assert.ok(page.results.length >= 3, `expected ≥3 Austin hits, got ${page.results.length}`);
  assert.ok(page.results.every((hit) => hit.address.city === "Austin"));
  for (const hit of page.results) {
    assertHit(hit);
  }
  assert.ok(page.results.some((hit) => hit.name === "Franklin Barbecue"));
  const franklin = loadPlaceFixtures().find((row) => row.slug === "franklin-bbq-austin");
  assert.ok(franklin);
  assert.equal(
    page.results.find((hit) => hit.name === "Franklin Barbecue")?.id,
    placeIdFromCanonical(franklin.mapsUrl),
  );
});

test("q + city and bbox filter the fixture catalog", () => {
  const pizza = searchPlaces({ q: "pizza", city: "Austin" });
  assert.equal(pizza.results.length, 1);
  assert.equal(pizza.results[0]?.name, "Home Slice Pizza");

  const coffeeLondon = searchPlaces({ q: "coffee", city: "London" });
  assert.equal(coffeeLondon.results.length, 1);
  assert.equal(coffeeLondon.results[0]?.name, "Monmouth Coffee Company");

  const box = searchPlaces({ bbox: "-97.76,30.24,-97.72,30.28" });
  assert.ok(box.results.length >= 3);
  assert.ok(box.results.every((hit) => hit.address.city === "Austin"));

  const limited = searchPlaces({ city: "London", limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.query.limit, 2);
});

test("SPEC 4: search without city or bbox is search_too_broad", () => {
  for (const input of [{}, { q: "coffee" }, { q: "coffee", city: "" }]) {
    try {
      searchPlaces(input);
      assert.fail(`expected search_too_broad for ${JSON.stringify(input)}`);
    } catch (err) {
      assert.ok(err instanceof PlaceError);
      assert.equal(err.code, "search_too_broad");
    }
  }
});

test("oversized bbox is search_too_broad; inverted/junk bbox is invalid_request", () => {
  try {
    searchPlaces({ bbox: "-180,-90,180,90" });
    assert.fail("expected search_too_broad");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "search_too_broad");
  }
  try {
    searchPlaces({ bbox: "1,2,0,3" });
    assert.fail("expected invalid_request");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "invalid_request");
  }
  try {
    searchPlaces({ city: "Austin", limit: "nope" });
    assert.fail("expected invalid_request");
  } catch (err) {
    assert.ok(err instanceof PlaceError);
    assert.equal(err.code, "invalid_request");
  }
});

test("GET /v1/search coffee+Austin is 200 empty, 0 credits (SPEC 3)", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=coffee&city=Austin",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: SearchPage;
    meta: { creditsCharged: number; cached: boolean; requestId: string };
  };
  assert.deepEqual(body.data.results, []);
  assert.equal(body.data.query.q, "coffee");
  assert.equal(body.data.query.city, "Austin");
  assert.equal(body.meta.creditsCharged, 0);
  assert.match(body.meta.requestId, /^req_/);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  const meBody = me.json() as {
    data: { creditsRemaining: number; dailyRemaining: number };
  };
  assert.equal(meBody.data.creditsRemaining, DEFAULT_FREE_CREDITS);
  assert.equal(meBody.data.dailyRemaining, DEFAULT_FREE_DAILY_CAP);
});

test("GET /v1/search city=Austin returns ≥3 hits and charges result count", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?city=Austin",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: SearchPage;
    meta: { creditsCharged: number };
  };
  assert.ok(body.data.results.length >= 3);
  for (const hit of body.data.results) {
    assertHit(hit);
  }
  assert.equal(body.meta.creditsCharged, body.data.results.length);
  assert.ok(body.meta.creditsCharged >= SEARCH_MIN_CREDITS);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  const meBody = me.json() as {
    data: { creditsRemaining: number; dailyRemaining: number };
  };
  assert.equal(meBody.data.creditsRemaining, DEFAULT_FREE_CREDITS - body.meta.creditsCharged);
  assert.equal(meBody.data.dailyRemaining, DEFAULT_FREE_DAILY_CAP - body.meta.creditsCharged);
});

test("POST /v1/search matches GET; 1 result still bills the 3-credit minimum", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const posted = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/json",
    },
    payload: { q: "coffee", city: "London" },
  });
  assert.equal(posted.statusCode, 200);
  const postBody = posted.json() as { data: SearchPage; meta: { creditsCharged: number } };
  assert.equal(postBody.data.results.length, 1);
  assert.equal(postBody.data.results[0]?.name, "Monmouth Coffee Company");
  assert.equal(postBody.meta.creditsCharged, SEARCH_MIN_CREDITS);

  const got = await app.inject({
    method: "GET",
    url: "/v1/search?q=coffee&city=London",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(got.statusCode, 200);
  const getBody = got.json() as { data: SearchPage; meta: { creditsCharged: number } };
  assert.equal(getBody.data.results[0]?.id, postBody.data.results[0]?.id);
  assert.equal(getBody.meta.creditsCharged, SEARCH_MIN_CREDITS);
});

test("SPEC 4 HTTP: search without city is 400 search_too_broad and 0 credits", async () => {
  const app = await buildApp({ bootstrapKey: TEST_KEY });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=coffee",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as {
    error: { code: ErrorCode; retryable: boolean };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "search_too_broad");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${TEST_KEY}` },
  });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number; dailyRemaining: number } }).data
      .creditsRemaining,
    DEFAULT_FREE_CREDITS,
  );
  assert.equal(
    (me.json() as { data: { dailyRemaining: number } }).data.dailyRemaining,
    DEFAULT_FREE_DAILY_CAP,
  );
});

test("SPEC 6: burned daily budget is 429 daily_cap and 0 credits", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const secret = "lk_test_daily_cap";
  createKey(db, {
    secret,
    credits: 2000,
    dailyUsed: DEFAULT_FREE_DAILY_CAP,
  });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?city=Austin",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(response.statusCode, 429);
  const body = response.json() as {
    error: { code: ErrorCode; retryable: boolean };
    meta: { creditsCharged: number };
  };
  assert.equal(body.error.code, "daily_cap");
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.creditsCharged, 0);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${secret}` },
  });
  const meBody = me.json() as {
    data: { creditsRemaining: number; dailyRemaining: number };
  };
  assert.equal(meBody.data.creditsRemaining, 2000);
  assert.equal(meBody.data.dailyRemaining, 0);
});

test("daily remaining below the 3-credit search minimum is daily_cap", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const secret = "lk_test_daily_almost";
  const created = createKey(db, {
    secret,
    credits: 100,
    dailyUsed: DEFAULT_FREE_DAILY_CAP - 2,
  });
  assert.equal(dailyRemaining(created), 2);
  const blocked = tryCharge(db, created, SEARCH_MIN_CREDITS, "/v1/search");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, "daily_cap");
  }

  const app = await buildApp({ db });
  after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=coffee&city=London",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(response.statusCode, 429);
  assert.equal((response.json() as { error: { code: string } }).error.code, "daily_cap");
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("empty search at the daily cap still returns 200 and charges 0", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, {
    secret: "lk_test_daily_empty",
    dailyUsed: DEFAULT_FREE_DAILY_CAP,
  });
  const app = await buildApp({ db });
  after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=coffee&city=Austin",
    headers: { authorization: `Bearer lk_test_daily_empty` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual((response.json() as { data: SearchPage }).data.results, []);
  assert.equal((response.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});

test("search without bearer is 401; broke key is 402; both charge 0", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: "lk_test_broke_search", credits: 0 });
  const app = await buildApp({ db });
  after(() => app.close());

  const unauth = await app.inject({
    method: "GET",
    url: "/v1/search?city=Austin",
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as { error: { code: string } }).error.code, "unauthorized");
  assert.equal((unauth.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);

  const broke = await app.inject({
    method: "GET",
    url: "/v1/search?city=Austin",
    headers: { authorization: "Bearer lk_test_broke_search" },
  });
  assert.equal(broke.statusCode, 402);
  assert.equal((broke.json() as { error: { code: string } }).error.code, "payment_required");
  assert.equal((broke.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 0);
});
