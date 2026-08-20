import type { PlaceIndex, PlacesAdapter } from "../core/adapter.js";
import { createFixtureAdapter } from "./maps/fixture.js";
import { createLiveMapsAdapter } from "./maps/live.js";

export type { PlacesAdapter, PlacesAdapterKind, PlaceIndex } from "../core/adapter.js";
export { createFixtureAdapter } from "./maps/fixture.js";
export { createLiveMapsAdapter, type LiveFetch } from "./maps/live.js";

export const LIVE_ENV_FLAG = "LOCALAPI_LIVE";
export const LIVE_API_KEY_ENV = "LOCALAPI_MAPS_API_KEY";

export function isLiveMapsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env[LIVE_ENV_FLAG];
  return flag === "1" || flag === "true";
}

export type CreateAppAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  placeIndex?: PlaceIndex;
};

/** Default is the 30-place fixture adapter. Live Maps only when LOCALAPI_LIVE=1. */
export function createAppAdapter(options: CreateAppAdapterOptions = {}): PlacesAdapter {
  const env = options.env ?? process.env;
  if (!isLiveMapsEnabled(env)) {
    return createFixtureAdapter();
  }
  const apiKey = env[LIVE_API_KEY_ENV];
  return createLiveMapsAdapter({
    apiKey: apiKey !== undefined && apiKey.trim() !== "" ? apiKey : undefined,
    placeIndex: options.placeIndex,
  });
}
