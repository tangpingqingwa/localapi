import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PlaceError } from "../src/core/errors.js";
import { placeIdFromCanonical } from "../src/core/place.js";
import {
  looksLikeBotWall,
  parsePublicMapsPlaceBody,
  parsePublicMapsSearchBody,
  publicMapsPlaceLookupUrl,
} from "../src/adapters/maps/public-page.js";
import { createLiveMapsAdapter } from "../src/adapters/maps/live.js";
import type { LiveFetch } from "../src/adapters/maps/live.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/maps");
const FRANKLIN_JSON = readFileSync(join(FIXTURES, "franklin-tbm-map.json"), "utf8");
const COFFEE_JSON = readFileSync(join(FIXTURES, "coffee-austin-tbm-map.json"), "utf8");
const BOT_WALL = readFileSync(join(FIXTURES, "bot-wall.html"), "utf8");
const UNPARSEABLE = readFileSync(join(FIXTURES, "unparseable.html"), "utf8");
const FRANKLIN_URL =
  "https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z";
const NOW = new Date("2026-08-20T12:00:00.000Z");

test("public tbm=map JSON parses Franklin name and formatted address", () => {
  const place = parsePublicMapsPlaceBody(FRANKLIN_JSON, FRANKLIN_URL, NOW);
  assert.equal(place.name, "Franklin Barbecue");
  assert.match(place.address.formatted, /900 E 11th St/);
  assert.match(place.address.formatted, /Austin/);
  assert.equal(place.address.country, "US");
  assert.equal(place.id, placeIdFromCanonical(FRANKLIN_URL));
  assert.equal(place.phone, "+1 512-653-1187");
  assert.equal(place.website, "https://franklinbarbecue.com/");
  assert.equal(place.rating.average, 4.7);
});

test("same Maps URL always hashes to the same plc_ from the public parser", () => {
  const a = parsePublicMapsPlaceBody(FRANKLIN_JSON, FRANKLIN_URL, NOW);
  const variant =
    "http://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z?utm_source=share&hl=en";
  const b = parsePublicMapsPlaceBody(FRANKLIN_JSON, variant, NOW);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^plc_[a-z2-7]+$/);
});

test("public search JSON returns real coffee shops and never invents a row", () => {
  const hits = parsePublicMapsSearchBody(COFFEE_JSON);
  assert.ok(hits.length >= 3);
  for (const row of hits) {
    assert.match(row.hit.id, /^plc_[a-z2-7]+$/);
    assert.ok(row.hit.name.length > 0);
    assert.ok(row.hit.address.formatted.length > 0);
    assert.equal(row.hit.address.country, "US");
  }
  assert.equal(
    hits.some((row) => row.hit.name === "Invented Coffee"),
    false,
  );
});

test("bot wall HTML is upstream_blocked, never an invented place", () => {
  assert.equal(looksLikeBotWall(BOT_WALL), true);
  assert.throws(
    () => parsePublicMapsPlaceBody(BOT_WALL, FRANKLIN_URL, NOW),
    (err: unknown) => err instanceof PlaceError && err.code === "upstream_blocked",
  );
  assert.throws(
    () => parsePublicMapsSearchBody(BOT_WALL),
    (err: unknown) => err instanceof PlaceError && err.code === "upstream_blocked",
  );
});

test("unparseable Maps shell is upstream_blocked,  not a guessed listing", () => {
  assert.equal(looksLikeBotWall(UNPARSEABLE), false);
  assert.throws(
    () => parsePublicMapsPlaceBody(UNPARSEABLE, FRANKLIN_URL, NOW),
    (err: unknown) => err instanceof PlaceError && err.code === "upstream_blocked",
  );
});

test("live adapter without a Places key fetches public tbm=map JSON", async () => {
  const lookup = publicMapsPlaceLookupUrl(new URL(FRANKLIN_URL));
  const fetchImpl: LiveFetch = async (input) => {
    if (input !== lookup) {
      throw new Error(`unexpected live request ${input}`);
    }
    return {
      status: 200,
      url: input,
      json: async () => JSON.parse(FRANKLIN_JSON.replace(/^\)\]\}'\s*/, "")),
      text: async () => FRANKLIN_JSON,
    };
  };
  const adapter = createLiveMapsAdapter({ fetchImpl, now: () => NOW });
  const place = await adapter.getPlaceByUrl(FRANKLIN_URL, NOW);
  assert.equal(place.name, "Franklin Barbecue");
  assert.match(place.address.formatted, /900 E 11th St/);
  assert.equal(place.id, placeIdFromCanonical(FRANKLIN_URL));
});

test("live adapter maps public-page bot wall to upstream_blocked", async () => {
  const lookup = publicMapsPlaceLookupUrl(new URL(FRANKLIN_URL));
  const fetchImpl: LiveFetch = async (input) => {
    if (input !== lookup) {
      throw new Error(`unexpected live request ${input}`);
    }
    return {
      status: 200,
      url: input,
      json: async () => ({}),
      text: async () => BOT_WALL,
    };
  };
  const adapter = createLiveMapsAdapter({ fetchImpl });
  await assert.rejects(
    () => adapter.getPlaceByUrl(FRANKLIN_URL),
    (err: unknown) => err instanceof PlaceError && err.code === "upstream_blocked",
  );
});
