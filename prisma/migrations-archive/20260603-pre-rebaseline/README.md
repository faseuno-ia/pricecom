# Migraciones archivadas — pre-rebaseline 2026-06-03

Las 12 migraciones de esta carpeta vivieron en `prisma/migrations/` hasta el
rebaseline del 2026-06-03. **NO se aplican ya**: el nuevo baseline único
`prisma/migrations/20260603000000_baseline/` representa el schema completo
de prod desde-vacío-hasta-hoy, reemplazando todo este historial.

Quedan archivadas como referencia histórica:
- Para entender cambios incrementales pasados (qué columna se agregó cuándo).
- Como rollback de última instancia si el rebaseline diera vuelta atrás
  (no esperado).

## Motivo del rebaseline

El init original (`20260508025918_init`) era un esqueleto que NO reconstruía
el schema real de prod — solo creaba 6 de las ~20 tablas (User, Provider,
ProviderScraperConfig, ExtractionJob, ExtractedProduct, ExtractionLog) y 2
de los enums. Las 11 migraciones posteriores hacían `ALTER TABLE` sobre
tablas que NUNCA habían sido creadas por una migración (ProductChange,
ProductPublication, CatalogProduct, UnmatchedStoreProduct, Store, etc.).

Prod funcionaba porque su schema se había construido inicialmente con
`prisma db push` masivo (sin migraciones formales), y las migraciones se
empezaron a usar para cambios incrementales sobre ese estado. El init
quedó como artefacto histórico, no como punto de partida válido.

**Consecuencias del estado roto:**
- Imposible bootstrappear una DB nueva desde el repo (`migrate deploy`
  desde vacío fallaba en la migración 2 con "relation ProductChange does
  not exist").
- Riesgo de continuidad: si prod se caía, no había forma de recrear el
  schema desde el repo.
- Tests/CI/staging requerían `db push --force-reset` como bypass.

Documentado en su momento en `docs/known-debts.md` →
"Migration history no reconstruye el schema de prod (riesgo de continuidad)".

## Cómo se resolvió

1. `prisma db pull` contra prod (DATABASE_URL) → introspección del schema
   real. Coincidencia con `schema.prisma` salvo el cascade behavior de las
   FKs de EventLog (NoAction en prod, default SetNull en `schema.prisma`).
2. Reconciliación: `schema.prisma` actualizado para declarar
   `onDelete: NoAction, onUpdate: NoAction` explícito en las 6 FKs de
   EventLog → coincide byte-por-byte con prod.
3. Generación del nuevo baseline:
   `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
4. Archivado de estas 12 viejas en esta carpeta.
5. En prod: `prisma migrate resolve --rolled-back <vieja>` × 12 +
   `prisma migrate resolve --applied <baseline>` para alinear
   `_prisma_migrations` con el repo, sin re-ejecutar DDL.

## Listado de las migraciones archivadas

En orden cronológico de aplicación en prod (todas APPLIED):

1. `20260508025918_init` — esqueleto (6 tablas + 2 enums)
2. `20260521230135_add_extraction_job_source`
3. `20260522193033_add_publication_overrides`
4. `20260523143820_add_provider_list_discount`
5. `20260524024208_add_event_log`
6. `20260524213709_add_unmatched_external_status`
7. `20260525010958_rename_unmatched_ignored_to_resolved`
8. `20260525200701_add_paused_by_system`
9. `20260528013634_add_extraction_excel_data`
10. `20260530190403_add_provider_sku_prefix`
11. `20260530201916_add_publication_lazy_sku`
12. `20260601130727_add_error_sku_conflict`
