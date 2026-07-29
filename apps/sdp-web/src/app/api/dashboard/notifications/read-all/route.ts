import { proxyNotifications } from "@/lib/notifications-proxy";

// POST mark all of the current user's notifications read.
export async function POST(request: Request) {
  return proxyNotifications(request, "/read-all", { method: "POST" });
}
