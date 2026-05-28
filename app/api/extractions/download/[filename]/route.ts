import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

/**
 * Sirve el Excel de una extracción desde DB (columna ExtractionJob.excelData).
 * Antes vivía en el filesystem (/exports/...) pero Railway es efímero y los
 * archivos se perdían en cada redeploy. Ahora el worker persiste el binario
 * en la DB.
 *
 * El filename es la clave por la que se busca (ExtractionJob.excelName). Se
 * filtra también por userId para no servir Excels de otros usuarios.
 */
export async function GET(
  _: NextRequest,
  { params }: { params: { filename: string } }
) {
  const session = await requireSession();
  const { filename } = params;

  // Defensa básica: solo nombres "plain" .xlsx; no permitimos paths ni chars raros.
  if (!filename || !/^[\w\-]+\.xlsx$/.test(filename)) {
    return NextResponse.json({ error: "Nombre de archivo inválido" }, { status: 400 });
  }

  const job = await prisma.extractionJob.findFirst({
    where: { userId: session.user.id, excelName: filename },
    select: { excelData: true, excelName: true },
  });

  if (!job?.excelData) {
    // Jobs históricos: vivían en filesystem y los archivos están perdidos
    // (Railway redeploys). Sin recuperación posible.
    return NextResponse.json(
      {
        error:
          "Archivo no disponible. Si es una extracción antigua, regenerala desde Extracciones.",
      },
      { status: 404 }
    );
  }

  // Prisma devuelve Bytes como Buffer (Node), pero los tipos DOM piden
  // ArrayBuffer "estricto" en BlobPart/BodyInit. El runtime acepta Buffer sin
  // problema; el cast es solo para el type-checker.
  return new NextResponse(job.excelData as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${job.excelName}"`,
      "Content-Length": String(job.excelData.byteLength),
    },
  });
}
