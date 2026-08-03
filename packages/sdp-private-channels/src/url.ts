// Shared URL validation for probes. Same rule everywhere: trimmed, parseable,
// http(s). Returns { error } instead of throwing so probe callers can surface
// it as an unreachable result without try/catch.

import { badRequest } from "./errors";

export function parseHttpUrl(input: string, label = "URL"): { url: URL } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: `${label} is required.` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: `Invalid URL: ${trimmed}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `Unsupported protocol: ${url.protocol}` };
  }
  return { url };
}

// Base URL for path concatenation: `${protocol}//${host}${path}`, no trailing slash.
export function normalizeHttpBase(
  input: string,
  label = "URL"
): { base: string } | { error: string } {
  const parsed = parseHttpUrl(input, label);
  if ("error" in parsed) return parsed;
  const { url } = parsed;
  return { base: `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}` };
}

/** Throwing variant for config validation. */
export function assertHttpUrl(value: string, field: string): string {
  if ("error" in parseHttpUrl(value)) {
    throw badRequest(`Invalid URL for ${field}: ${value}`);
  }
  return value;
}
