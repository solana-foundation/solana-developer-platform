import { proxyNotifications } from "@/lib/notifications-proxy";

// GET the current user's unread notification count (drives the bell badge).
export async function GET(request: Request) {
  return proxyNotifications(request, "/unread-count");
}
