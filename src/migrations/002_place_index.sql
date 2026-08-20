CREATE TABLE place_index (
  id TEXT PRIMARY KEY,
  maps_url TEXT NOT NULL UNIQUE,
  vendor_place_id TEXT,
  created_at TEXT NOT NULL
);
