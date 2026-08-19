import type { Key } from "../billing/keys.js";
import type { LocalApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: LocalApiDb;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
