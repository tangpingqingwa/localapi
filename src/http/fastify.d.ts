import type { Key } from "../billing/keys.js";
import type { PlacesAdapter } from "../core/adapter.js";
import type { LocalApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: LocalApiDb;
    adapter: PlacesAdapter;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
