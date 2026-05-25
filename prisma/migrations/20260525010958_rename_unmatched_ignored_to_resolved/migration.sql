-- Rename UnmatchedStoreProduct.ignored → resolved + reindex.
-- El campo ahora cubre todos los caminos por los que un unmatched sale de
-- la pestaña: vinculado (link), creado en Mi stock (create-catalog) o
-- descartado manualmente (resolve). La distinción "vinculado vs descartado"
-- se hace mirando si existe una ProductPublication con el mismo
-- externalProductId.

ALTER TABLE "UnmatchedStoreProduct"
  RENAME COLUMN "ignored" TO "resolved";

ALTER INDEX "UnmatchedStoreProduct_storeId_ignored_idx"
  RENAME TO "UnmatchedStoreProduct_storeId_resolved_idx";
