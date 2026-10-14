export function resolvePlaygroundApiBaseUrl(): string | null {
  const baseUrl =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "";

  return baseUrl.replace(/\/$/, "") || null;
}
