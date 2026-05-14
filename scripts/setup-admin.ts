import { prisma } from "../lib/db/client";
import bcrypt from "bcryptjs";

async function main() {
  const password = await bcrypt.hash("admin123", 10);
  const user = await prisma.user.upsert({
    where: { email: "admin@pricecom.com" },
    update: {},
    create: {
      email: "admin@pricecom.com",
      password,
      name: "Admin",
    },
  });
  console.log("✓ Usuario creado/existente:", user.email, "(id:", user.id + ")");

  const providers = await prisma.provider.updateMany({
    where: { userId: null },
    data: { userId: user.id },
  });
  const jobs = await prisma.extractionJob.updateMany({
    where: { userId: null },
    data: { userId: user.id },
  });
  console.log(`✓ ${providers.count} proveedores migrados`);
  console.log(`✓ ${jobs.count} jobs migrados`);
  console.log("");
  console.log("Credenciales:");
  console.log("  email:    admin@pricecom.com");
  console.log("  password: admin123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
