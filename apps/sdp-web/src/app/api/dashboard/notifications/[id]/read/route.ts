import { proxyNotifications } from "@/lib/notifications-proxy";

// POST mark a single notification read.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyNotifications(request, `/${encodeURIComponent(id)}/read`, { method: "POST" });
}
