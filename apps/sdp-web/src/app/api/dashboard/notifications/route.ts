import { proxyNotifications } from "@/lib/notifications-proxy";

// GET the current user's notifications (forwards ?page / ?pageSize / ?unread).
export async function GET(request: Request) {
  const { search } = new URL(request.url);
  return proxyNotifications(request, search);
}
