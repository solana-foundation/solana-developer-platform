/** The dashboard deployment paired with this docs build. */
export function resolveDashboardUrl(): string | null {
  const configuredUrl = process.env.NEXT_PUBLIC_SDP_WEB_URL?.trim();
  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      if (parsed.pathname === "" || parsed.pathname === "/" || parsed.pathname === "/dashboard") {
        parsed.pathname = "/";
        parsed.search = "";
        parsed.hash = "";
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  return process.env.NODE_ENV !== "production" ? "http://localhost:3000/" : null;
}
