import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { createKey, DEFAULT_FREE_CREDITS, DEFAULT_FREE_DAILY_CAP } from "../src/billing/keys.js";
import { placeIdFromCanonical } from "../src/core/place.js";
import { SEARCH_MIN_CREDITS } from "../src/core/search.js";
import { openDatabase } from "../src/db.js";
import { MCP_PATH, MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";
import {
  GET_PLACE_TOOL,
  LIST_REVIEWS_TOOL,
  MCP_SKILL,
  SEARCH_PLACES_TOOL,
} from "../src/mcp/tools.js";
import type { ErrorCode, Place, ReviewPage, SearchPage } from "../src/types.js";

const KEY = "lk_test_mcp_fixture";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FRANKLIN =
  "https://www.google.com/maps/place/Franklin+Barbecue/@30.2701266,-97.7313161,17z/data=!3m1!4b1!4m6!3m5!1s0x8644b5a4c8c4bb7b:0x1a2b3c4d5e6f7001";
const DISHOOM =
  "https://www.google.com/maps/place/Dishoom+Covent+Garden/@51.5124,-0.1269,17z";
const BLUE_BOTTLE =
  "https://www.google.com/maps/place/Blue+Bottle+Coffee/@37.7763,-122.4232,17z";
const PARIS_CAFE =
  "https://www.google.com/maps/place/Café+de+Flore/@48.8540,2.3326,17z";
const SEARCH_URL = "https://www.google.com/maps/search/coffee/@30.2672,-97.7431,14z";

type OkBody<T> = {
  data: T;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: OkBody<unknown> | ErrBody;
  isError: boolean;
};

type JsonRpcOk = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

function franklinId(): string {
  return placeIdFromCanonical(FRANKLIN);
}

function blueBottleId(): string {
  return placeIdFromCanonical(BLUE_BOTTLE);
}

async function appWithKey(credits = DEFAULT_FREE_CREDITS) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({ db });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params?: unknown,
  headers: Record<string, string> = auth(),
) {
  return app.inject({
    method: "POST",
    url: MCP_PATH,
    headers,
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as JsonRpcOk;
  const result = body.result as ToolResult;
  assert.ok(result);
  assert.equal(typeof result.isError, "boolean");
  return result;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

function publicPlace(place: Place): Omit<Place, "fetchedAt"> {
  const { fetchedAt: _fetchedAt, ...rest } = place;
  return rest;
}

test("GET /llms.txt is public and matches the checked-in file", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({ method: "GET", url: "/llms.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  const onDisk = readFileSync(join(ROOT, "llms.txt"), "utf8");
  assert.equal(response.body, onDisk);
  assert.match(onDisk, /get_place/);
  assert.match(onDisk, /list_reviews/);
  assert.match(onDisk, /search_places/);
  assert.match(onDisk, /When not to call/i);
  assert.match(onDisk, /not for navigation/i);
  assert.match(onDisk, /impersonate/i);
  assert.match(onDisk, /public snapshots/i);
});

test("GET /.well-known/mcp/server-card.json lists shipped tools only", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/mcp/server-card.json",
  });
  assert.equal(response.statusCode, 200);
  const card = response.json() as { tools: string[]; transport: string };
  assert.equal(card.transport, "streamable-http");
  assert.deepEqual(card.tools, [GET_PLACE_TOOL, LIST_REVIEWS_TOOL, SEARCH_PLACES_TOOL]);
});

test("POST /mcp without bearer is 401 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await rpc(app, "initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("initialize and tools/list describe get_place, list_reviews, and search_places", async () => {
  const { app } = await appWithKey();

  const init = await rpc(app, "initialize");
  assert.equal(init.statusCode, 200);
  const initResult = (init.json() as JsonRpcOk).result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
    instructions: string;
  };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, "localapi");
  assert.ok(initResult.capabilities.tools);
  assert.equal(initResult.instructions, MCP_SKILL);
  assert.match(initResult.instructions, /not for navigation/i);
  assert.match(initResult.instructions, /impersonate/i);

  const listed = await rpc(app, "tools/list");
  assert.equal(listed.statusCode, 200);
  const tools = (
    (listed.json() as JsonRpcOk).result as { tools: Array<{ name: string }> }
  ).tools.map((tool) => tool.name);
  assert.deepEqual(tools, [GET_PLACE_TOOL, LIST_REVIEWS_TOOL, SEARCH_PLACES_TOOL]);
});

test("MCP get_place url matches REST and charges 1", async () => {
  const { app } = await appWithKey();

  const rest = await app.inject({
    method: "GET",
    url: `/v1/places/by-url?url=${encodeURIComponent(FRANKLIN)}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<Place>;
  assert.equal(restBody.data.name, "Franklin Barbecue");
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, GET_PLACE_TOOL, { url: FRANKLIN });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Place>;
  assert.deepEqual(publicPlace(mcpBody.data), publicPlace(restBody.data));
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.cached, false);
  assert.match(mcpBody.meta.requestId, /^req_/);
  assert.equal("photos" in mcpBody.data, false);

  const parsedText = JSON.parse(mcp.content[0]?.text ?? "null") as OkBody<Place>;
  assert.equal(parsedText.data.id, restBody.data.id);

  const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth() });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining,
    DEFAULT_FREE_CREDITS - 2,
  );
});

test("MCP get_place id matches REST by-id", async () => {
  const { app } = await appWithKey();
  const id = franklinId();

  const rest = await app.inject({
    method: "GET",
    url: `/v1/places/${id}`,
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<Place>;

  const mcp = await callTool(app, GET_PLACE_TOOL, { id });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Place>;
  assert.deepEqual(publicPlace(mcpBody.data), publicPlace(restBody.data));
  assert.equal(mcpBody.meta.creditsCharged, 1);
});

test("MCP get_place errors match REST and charge 0", async () => {
  const { app } = await appWithKey();

  const missing = await callTool(app, GET_PLACE_TOOL, {});
  assert.equal(missing.isError, true);
  assert.equal((missing.structuredContent as ErrBody).error.code, "invalid_request");
  assert.equal((missing.structuredContent as ErrBody).meta.creditsCharged, 0);

  const garbage = await callTool(app, GET_PLACE_TOOL, { url: SEARCH_URL });
  assert.equal((garbage.structuredContent as ErrBody).error.code, "invalid_place_url");
  assert.equal((garbage.structuredContent as ErrBody).meta.creditsCharged, 0);

  const region = await callTool(app, GET_PLACE_TOOL, { url: PARIS_CAFE });
  assert.equal((region.structuredContent as ErrBody).error.code, "region_unsupported");
  assert.equal((region.structuredContent as ErrBody).meta.creditsCharged, 0);

  const gone = await callTool(app, GET_PLACE_TOOL, { id: "plc_notreal" });
  assert.equal((gone.structuredContent as ErrBody).error.code, "place_not_found");
  assert.equal((gone.structuredContent as ErrBody).meta.creditsCharged, 0);

  const broke = await appWithKey(0);
  const unpaid = await callTool(broke.app, GET_PLACE_TOOL, { url: FRANKLIN });
  assert.equal((unpaid.structuredContent as ErrBody).error.code, "payment_required");
  assert.equal((unpaid.structuredContent as ErrBody).meta.creditsCharged, 0);

  const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth() });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number } }).data.creditsRemaining,
    DEFAULT_FREE_CREDITS,
  );
});

test("MCP list_reviews matches REST page 1 and never invents", async () => {
  const { app } = await appWithKey();
  const id = franklinId();

  const rest = await app.inject({
    method: "GET",
    url: `/v1/places/${id}/reviews`,
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<ReviewPage>;
  assert.ok(restBody.data.reviews.length >= 1);
  assert.equal(restBody.meta.creditsCharged, 1);

  const mcp = await callTool(app, LIST_REVIEWS_TOOL, { id });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<ReviewPage>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  for (const review of mcpBody.data.reviews) {
    assert.ok(review.stars >= 1 && review.stars <= 5);
    assert.ok(review.text.length > 0);
  }
});

test("MCP list_reviews empty catalog is empty page, still 1 credit", async () => {
  const { app } = await appWithKey();
  const empty = await callTool(app, LIST_REVIEWS_TOOL, { id: blueBottleId() });
  assert.equal(empty.isError, false);
  const emptyBody = empty.structuredContent as OkBody<ReviewPage>;
  assert.deepEqual(emptyBody.data.reviews, []);
  assert.equal(emptyBody.data.hasMore, false);
  assert.equal(emptyBody.meta.creditsCharged, 1);

  const beyond = await callTool(app, LIST_REVIEWS_TOOL, {
    id: franklinId(),
    page: 99,
  });
  assert.equal(beyond.isError, false);
  const beyondBody = beyond.structuredContent as OkBody<ReviewPage>;
  assert.deepEqual(beyondBody.data.reviews, []);
  assert.equal(beyondBody.data.page, 99);
});

test("MCP list_reviews lang and errors match REST", async () => {
  const { app } = await appWithKey();
  const id = placeIdFromCanonical(DISHOOM);

  const fr = await callTool(app, LIST_REVIEWS_TOOL, { id, lang: "fr" });
  assert.equal(fr.isError, false);
  const frBody = fr.structuredContent as OkBody<ReviewPage>;
  assert.equal(frBody.data.language, "fr");
  assert.equal(frBody.data.reviews.length, 1);

  const badPage = await callTool(app, LIST_REVIEWS_TOOL, { id, page: 0 });
  assert.equal((badPage.structuredContent as ErrBody).error.code, "invalid_request");
  assert.equal((badPage.structuredContent as ErrBody).meta.creditsCharged, 0);

  const gone = await callTool(app, LIST_REVIEWS_TOOL, { id: "plc_notreal" });
  assert.equal((gone.structuredContent as ErrBody).error.code, "place_not_found");
  assert.equal((gone.structuredContent as ErrBody).meta.creditsCharged, 0);
});

test("MCP search_places coffee+Austin is documented empty and 0 credits", async () => {
  const { app } = await appWithKey();
  const mcp = await callTool(app, SEARCH_PLACES_TOOL, { q: "coffee", city: "Austin" });
  assert.equal(mcp.isError, false);
  const body = mcp.structuredContent as OkBody<SearchPage>;
  assert.deepEqual(body.data.results, []);
  assert.equal(body.meta.creditsCharged, 0);

  const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth() });
  assert.equal(
    (me.json() as { data: { creditsRemaining: number; dailyRemaining: number } }).data
      .creditsRemaining,
    DEFAULT_FREE_CREDITS,
  );
});

test("MCP search_places city=Austin matches REST and bills result count", async () => {
  const { app } = await appWithKey();

  const rest = await app.inject({
    method: "GET",
    url: "/v1/search?city=Austin",
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<SearchPage>;
  assert.ok(restBody.data.results.length >= 3);

  const mcp = await callTool(app, SEARCH_PLACES_TOOL, { city: "Austin" });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<SearchPage>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, restBody.meta.creditsCharged);
  assert.ok(mcpBody.meta.creditsCharged >= SEARCH_MIN_CREDITS);
});

test("MCP search_places without city is search_too_broad and 0 credits", async () => {
  const { app } = await appWithKey();
  const mcp = await callTool(app, SEARCH_PLACES_TOOL, { q: "coffee" });
  assert.equal(mcp.isError, true);
  const body = mcp.structuredContent as ErrBody;
  assert.equal(body.error.code, "search_too_broad");
  assert.equal(body.meta.creditsCharged, 0);
});

test("MCP search_places burned daily budget is daily_cap and 0 credits", async () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, {
    secret: KEY,
    credits: 2000,
    dailyUsed: DEFAULT_FREE_DAILY_CAP,
  });
  const app = await buildApp({ db });
  after(() => app.close());

  const mcp = await callTool(app, SEARCH_PLACES_TOOL, { city: "Austin" });
  assert.equal(mcp.isError, true);
  const body = mcp.structuredContent as ErrBody;
  assert.equal(body.error.code, "daily_cap");
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.creditsCharged, 0);
});

test("unknown MCP tool is invalid_request with 0 credits", async () => {
  const { app } = await appWithKey();
  const result = await callTool(app, "get_photos", { id: franklinId() });
  assert.equal(result.isError, true);
  const body = result.structuredContent as ErrBody;
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.meta.creditsCharged, 0);
});

test("HTTP and MCP call core only and never import fixtures or photos", () => {
  const files = [...walkTs(join(ROOT, "src/http")), ...walkTs(join(ROOT, "src/mcp"))];
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /from ["'][^"']*fixtures\//, file);
    assert.doesNotMatch(src, /photo(s|Url|CDN)?\b/, file);
  }
  const tools = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
  assert.match(tools, /getPlaceByUrl/);
  assert.match(tools, /getPlaceById/);
  assert.match(tools, /getReviewPage/);
  assert.match(tools, /searchPlaces/);
});

test("no live Maps hosts are fetched from MCP sources", () => {
  for (const file of walkTs(join(ROOT, "src/mcp"))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(/, file);
    assert.doesNotMatch(src, /maps\.googleapis\.com|places\.googleapis\.com/, file);
  }
});
