import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

/**
 * Sirve archivos Excel desde la carpeta /exports de forma segura.
 * No expone la carpeta como asset estático para evitar listados.
 * Valida que el filename no contenga path traversal.
 */
export async function GET(
  _: NextRequest,
  { params }: { params: { filename: string } }
) {
  const { filename } = params;

  // Seguridad: solo permitir nombres de archivo simples sin rutas
  if (!filename || !/^[\w\-]+\.xlsx$/.test(filename)) {
    return NextResponse.json({ error: "Nombre de archivo inválido" }, { status: 400 });
  }

  const filePath = path.join(process.cwd(), "exports", filename);

  // Verificar que el archivo existe
  try {
    await fs.access(filePath);
  } catch {
    return NextResponse.json({ error: "Archivo no encontrado" }, { status: 404 });
  }

  const fileBuffer = await fs.readFile(filePath);

  return new NextResponse(fileBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": fileBuffer.byteLength.toString(),
    },
  });
}
