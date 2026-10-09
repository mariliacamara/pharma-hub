-- A store's settings can exist before the hub knows how the store appears on KuantoKusta.
--
-- Until now the row was created when the identity was found (by the first collection, or
-- by an operator), because store_slug was required. So the "easy adjust" threshold could
-- not be changed before a first collection. The slug becomes optional: a row without it
-- holds only the threshold, and the collection still works the identity out by itself.
--
-- Both statements take a brief exclusive lock on a table with one row per store.

ALTER TABLE kk_store_settings
  ALTER COLUMN store_slug DROP NOT NULL;

-- The seller id is learned from the pages of a store already known by its slug, never
-- on its own.
ALTER TABLE kk_store_settings
  ADD CONSTRAINT kk_store_settings_seller_needs_slug_check
  CHECK (seller_id IS NULL OR store_slug IS NOT NULL);
