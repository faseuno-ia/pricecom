import { getQueueDepth } from "@/lib/system/health";
import { getSession } from "@/lib/auth";
import { SidebarNav } from "./sidebar-nav";

export async function Sidebar() {
  const session = await getSession();
  const queueDepth = session?.user?.id ? await getQueueDepth(session.user.id) : 0;
  return <SidebarNav queueDepth={queueDepth} />;
}
