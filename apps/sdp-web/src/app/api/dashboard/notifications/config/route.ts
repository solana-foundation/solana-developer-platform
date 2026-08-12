import { proxyNotifications } from "@/lib/notifications-proxy";

// GET notification config — currently just { emailEnabled } (no provider details).
export async function GET(request: Request) {
  return proxyNotifications(request, "/config");
}
