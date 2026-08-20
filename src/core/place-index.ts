import type { LocalApiDb } from "../db.js";
import type { PlaceIndex, PlaceIndexRow } from "./adapter.js";
import { normalizeMapsUrl } from "./place.js";

type PlaceIndexSqlRow = {
  id: string;
  maps_url: string;
  vendor_place_id: string | null;
};

export function createMemoryPlaceIndex(
  seed: readonly PlaceIndexRow[] = [],
): PlaceIndex {
  const byId = new Map<string, PlaceIndexRow>();
  const byUrl = new Map<string, PlaceIndexRow>();
  const index: PlaceIndex = {
    getById(id) {
      return byId.get(id);
    },
    getByMapsUrl(normalizedUrl) {
      return byUrl.get(normalizedUrl);
    },
    put(row) {
      const stored: PlaceIndexRow = {
        id: row.id,
        mapsUrl: row.mapsUrl,
        vendorPlaceId: row.vendorPlaceId,
      };
      byId.set(stored.id, stored);
      byUrl.set(normalizeMapsUrl(stored.mapsUrl), stored);
    },
  };
  for (const row of seed) {
    index.put(row);
  }
  return index;
}

export function createSqlitePlaceIndex(db: LocalApiDb): PlaceIndex {
  const selectById = db.prepare<[string], PlaceIndexSqlRow>(
    `SELECT id, maps_url, vendor_place_id FROM place_index WHERE id = ?`,
  );
  const selectByUrl = db.prepare<[string], PlaceIndexSqlRow>(
    `SELECT id, maps_url, vendor_place_id FROM place_index WHERE maps_url = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO place_index (id, maps_url, vendor_place_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       maps_url = excluded.maps_url,
       vendor_place_id = excluded.vendor_place_id`,
  );

  return {
    getById(id) {
      return toRow(selectById.get(id));
    },
    getByMapsUrl(normalizedUrl) {
      return toRow(selectByUrl.get(normalizeMapsUrl(normalizedUrl)));
    },
    put(row) {
      upsert.run(
        row.id,
        normalizeMapsUrl(row.mapsUrl),
        row.vendorPlaceId,
        new Date().toISOString(),
      );
    },
  };
}

function toRow(row: PlaceIndexSqlRow | undefined): PlaceIndexRow | undefined {
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    mapsUrl: row.maps_url,
    vendorPlaceId: row.vendor_place_id,
  };
}
