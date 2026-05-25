// One-off: exportar los 347 unmatched store products marcados resolved=true
// SIN ProductPublication asociada, para que el cliente complete el SKU del
// proveedor y el nombre del proveedor manualmente.

import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import path from "node:path";

const prisma = new PrismaClient();

interface Row {
  externalSku: string | null;
  name: string;
  price: string | null;
  externalStatus: string | null;
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  const store = await prisma.store.findFirst({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!store) throw new Error("Store no encontrado");

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      u."externalSku",
      u.name,
      u.price,
      u."externalStatus"
    FROM "UnmatchedStoreProduct" u
    LEFT JOIN "ProductPublication" pp
      ON pp."externalProductId" = u."externalProductId"
    WHERE u.resolved = true
      AND pp.id IS NULL
      AND u."storeId" = ${store.id}
    ORDER BY u."externalSku"
  `;
  console.log(`Filas a exportar: ${rows.length}`);

  const wb = new ExcelJS.Workbook();
  wb.creator = "PricEcom";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Productos a vincular", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "SKU Comercial (Woo)", key: "externalSku", width: 22 },
    { header: "Nombre producto", key: "name", width: 60 },
    { header: "Precio en tienda", key: "price", width: 16 },
    { header: "Estado en Woo", key: "externalStatus", width: 16 },
    { header: "SKU Proveedor (completar)", key: "supplierSku", width: 28 },
    { header: "Proveedor (completar)", key: "supplier", width: 22 },
  ] as Partial<ExcelJS.Column>[];

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell, col) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    // Las columnas 5 y 6 (las que el cliente debe completar) van en otro color
    // para que sea obvio dónde escribir.
    const isFillIn = col === 5 || col === 6;
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isFillIn ? "FFCC6600" : "FF1E3A5F" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  for (const r of rows) {
    sheet.addRow({
      externalSku: r.externalSku ?? "",
      name: r.name,
      price: r.price ? Number(r.price) : null,
      externalStatus: r.externalStatus ?? "",
      supplierSku: "",
      supplier: "",
    });
  }

  sheet.getColumn("price").numFmt = '"$"#,##0.00';
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

  const outPath = path.join(process.cwd(), "productos-a-vincular.xlsx");
  await wb.xlsx.writeFile(outPath);
  console.log(`✓ Escrito: ${outPath}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
