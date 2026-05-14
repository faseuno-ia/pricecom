import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

/**
 * Sirve archivos Excel desde la carpeta /exports de forma segura.
 * Valida path traversal y que el job dueño del archivo pertenezca al usuario.
 */
export async function GET(
  _: NextRequest,
  { params }: { params: { filename: string } }
) {
  const session = await requireSession();
  const { filename } = params;

  // Seguridad: solo permitir nombres de archivo simples sin rutas
  if (!filename || !/^[\w\-]+\.xlsx$/.test(filename)) {
    return NextResponse.json({ error: "Nombre de archivo inválido" }, { status: 400 });
  }

  // Verificar que el filename pertenezca a un job del usuario logueado
  // (el worker guarda el nombre del archivo en excelFilePath o en excelFileUrl).
  const job = await prisma.extractionJob.findFirst({
    where: {
      userId: session.user.id,
      OR: [
        { excelFilePath: { contains: filename } },
        { excelFileUrl: { contains: filename } },
      ],
    },
    select: { id: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Archivo no encontrado" }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), "exports", filename);

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
