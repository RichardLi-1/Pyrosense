-- Drops the v1 scaffold schema (gas_samples / poses / map_snapshots /
-- field_estimates / gas_cells_10s / sessions / old alerts). DESTRUCTIVE.
-- Then apply db/schema.sql.
DROP MATERIALIZED VIEW IF EXISTS gas_cells_10s CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS field_estimates CASCADE;
DROP TABLE IF EXISTS map_snapshots CASCADE;
DROP TABLE IF EXISTS poses CASCADE;
DROP TABLE IF EXISTS gas_samples CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
