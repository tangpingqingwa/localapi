import Fastify, { type FastifyInstance } from "fastify";
import { createAppAdapter } from "./adapters/index.js";
import { bootstrapKeyIfEmpty } from "./billing/keys.js";
import type { PlacesAdapter } from "./core/adapter.js";
import { createSqlitePlaceIndex } from "./core/place-index.js";
import { openDatabase, type LocalApiDb } from "./db.js";
import { healthRoutes } from "./http/routes/health.js";
import { meRoutes } from "./http/routes/me.js";
import { placesRoutes } from "./http/routes/places.js";
import { searchRoutes } from "./http/routes/search.js";
import { mcpRoutes } from "./mcp/server.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: LocalApiDb;
  databasePath?: string;
  bootstrapKey?: string;
  adapter?: PlacesAdapter;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(options.databasePath ?? ":memory:");
  if (options.bootstrapKey !== undefined) {
    bootstrapKeyIfEmpty(db, options.bootstrapKey);
  }
  const adapter =
    options.adapter ??
    createAppAdapter({
      placeIndex: createSqlitePlaceIndex(db),
    });
  app.decorate("db", db);
  app.decorate("adapter", adapter);
  app.decorateRequest("apiKey", undefined);
  if (ownsDb) {
    app.addHook("onClose", async (instance) => {
      instance.db.close();
    });
  }
  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(placesRoutes);
  await app.register(searchRoutes);
  await app.register(mcpRoutes);
  return app;
}
