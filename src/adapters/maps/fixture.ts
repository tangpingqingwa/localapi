import type { PlacesAdapter } from "../../core/adapter.js";
import { getHoursByPlaceId } from "../../core/hours.js";
import { getPlaceById, getPlaceByUrl } from "../../core/place.js";
import { getReviewPage } from "../../core/reviews.js";
import { searchPlaces } from "../../core/search.js";

/** Default adapter: 30 US/UK fixtures. No network. */
export function createFixtureAdapter(): PlacesAdapter {
  return {
    kind: "fixture",
    async getPlaceByUrl(url, now) {
      return getPlaceByUrl(url, now);
    },
    async getPlaceById(id, now) {
      return getPlaceById(id, now);
    },
    async getReviewPage(placeId, query) {
      return getReviewPage(placeId, query);
    },
    async getHoursByPlaceId(id) {
      return getHoursByPlaceId(id);
    },
    async searchPlaces(input) {
      return searchPlaces(input);
    },
  };
}
