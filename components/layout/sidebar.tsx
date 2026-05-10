import { getQueueDepth } from "@/lib/system/health";
import { SidebarNav } from "./sidebar-nav";

export async function Sidebar() {
  const queueDepth = await getQueueDepth();
  return <SidebarNav queueDepth={queueDepth} />;
}
