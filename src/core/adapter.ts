import type { Hours, Place, ReviewPage, SearchPage } from "../types.js";
import type { SearchInput } from "./search.js";

export type PlacesAdapterKind = "fixture" | "live";

export type PlaceIndexRow = {
  id: string;
  mapsUrl: string;
  vendorPlaceId: string | null;
};

/** Internal plc_ → Maps URL / vendor id. Customers never send the vendor id. */
export type PlaceIndex = {
  getById(id: string): PlaceIndexRow | undefined;
  getByMapsUrl(normalizedUrl: string): PlaceIndexRow | undefined;
  put(row: PlaceIndexRow): void;
};

export type PlacesAdapter = {
  readonly kind: PlacesAdapterKind;
  getPlaceByUrl(url: string, now?: Date): Promise<Place>;
  getPlaceById(id: string, now?: Date): Promise<Place>;
  getReviewPage(
    placeId: string,
    query?: { page?: string | number; lang?: string },
  ): Promise<ReviewPage>;
  getHoursByPlaceId(id: string): Promise<Hours | null>;
  searchPlaces(input: SearchInput): Promise<SearchPage>;
};
