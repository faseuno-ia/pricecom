import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";

export async function getSession() {
  return getServerSession(authOptions);
}

export async function requireSession() {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session as { user: { id: string; email?: string | null; name?: string | null } };
}
