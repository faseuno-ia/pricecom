# Known debts

Deudas técnicas reconocidas en producción, ordenadas por urgencia esperada.
Cada entrada incluye qué cubrir, el trigger que la activa como prioritaria, y
la solución concreta cuando se decida atacarla.

---

## TOCTOU en guard 3 del SKU (Fase 4B)

**Contexto.** El endpoint `PUT /api/catalog/publications/[id]/sku` y los
flujos `publishProductToWoo` CREATE/UPDATE-con-drift hacen un `GET
/products?sku=X` contra Woo (función `assertSkuNotInWoo`) ANTES de pushear.
Si el GET dice "libre" se persiste `pp.sku` y se hace el PUT/POST.

**Condición de carrera.** Entre el GET del guard y el PUT/POST del push, otro
proceso (usuario concurrente, integración externa cargando productos en Woo)
puede crear un producto con el mismo SKU. El push entonces falla con HTTP 400
`product_invalid_sku`. El código actual lo trata como error transitorio →
marca `pendingSync=true, syncStatus=ERROR`. El retry desde Mi Tienda
volvería a fallar igual: bucle de reintentos sin éxito.

**Impacto hoy.** Despreciable con un solo operador y sin integraciones
externas paralelas a WooCommerce. La ventana entre GET y PUT es chica
(cientos de ms) y nadie más toca Woo.

**Trigger para atacarla.**
- Cliente agrega un segundo operador con acceso al drawer / publicar.
- Aparece una integración externa que crea productos en Woo (otra app,
  importador masivo de Excel directo a Woo, etc.).
- Se observa al menos 1 incidente real del bucle.

**Solución cuando importe.** En el `catch` del push (tanto en el endpoint 4B
como en `publishProductToWoo`), inspeccionar el cuerpo del error. Si Woo
devolvió HTTP 400 con `code === "product_invalid_sku"` (formato documentado
de WC REST API v3), tratar como `ERROR_SKU_CONFLICT` en lugar de `ERROR`
transitorio: marcar `pendingSync=false`, syncStatus=ERROR_SKU_CONFLICT, log
con el error original. Cierra la ventana sin GET extra. Aproximadamente 15
líneas, contenidas a los catches existentes.

**No anticipar.** Mientras sea single-operator, el guard 3 pre-push cubre
estadísticamente el 100% de los casos.

---
