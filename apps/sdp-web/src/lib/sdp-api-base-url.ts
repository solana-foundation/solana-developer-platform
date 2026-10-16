/** The env vars that can name the SDP API base URL, in precedence order. */
export type SdpApiBaseUrlEnv = Partial<
  Record<"SDP_API_BASE_URL" | "NEXT_PUBLIC_SDP_API_BASE_URL" | "NEXT_PUBLIC_API_BASE_URL", string>
>;

/**
 * Reads the SDP API base URL without a trailing slash, or null when no var names one.
 * Kept free of server-only imports so instrumentation can use it at boot.
 */
export function findSdpApiBaseUrl(env: SdpApiBaseUrlEnv): string | null {
  const base =
    env.SDP_API_BASE_URL || env.NEXT_PUBLIC_SDP_API_BASE_URL || env.NEXT_PUBLIC_API_BASE_URL;
  return base ? base.replace(/\/$/, "") : null;
}
