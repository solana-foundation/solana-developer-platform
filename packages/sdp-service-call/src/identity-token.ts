import { decodeJwt } from "jose";
import { createProcessCache } from "./process-cache";

const METADATA_TIMEOUT_MS = 10_000;

/** Cloud Run audience to its identity token, refreshed a minute before it expires. */
const identityTokens = createProcessCache<string>((token) => resolveTokenRefreshAt(token));

export function createCloudRunIdentityTokenProvider(
  audience: string,
  options: { audienceSetting: string }
): () => Promise<string> {
  const normalizedAudience = audience.trim();
  if (!normalizedAudience) {
    throw new Error(`${options.audienceSetting} cannot be empty`);
  }

  return () =>
    identityTokens.get(normalizedAudience, () => fetchCloudRunIdentityToken(normalizedAudience));
}

/**
 * Mint a Google OIDC identity token for `audience` from the metadata server.
 *
 * @param audience - The private Cloud Run service the token authenticates to.
 * @returns The token.
 */
async function fetchCloudRunIdentityToken(audience: string): Promise<string> {
  const endpoint = new URL(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
  );
  endpoint.searchParams.set("audience", audience);
  endpoint.searchParams.set("format", "full");
  // Bounded inside the shared load: a stalled fetch would otherwise hold the cache's in-flight
  // entry, and every later request for the audience would wait on it. The signal also bounds the
  // body read below.
  const response = await fetch(endpoint, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Cloud Run identity token request failed with HTTP ${response.status}`);
  }

  const token = (await response.text()).trim();
  if (!token) {
    throw new Error("Cloud Run identity token response was empty");
  }
  return token;
}

export function assertCloudRunIdentityDestination(input: {
  url: string;
  audience: string;
  urlSetting: string;
  audienceSetting: string;
}): void {
  const { urlSetting, audienceSetting } = input;
  let destination: URL;
  let trustedAudience: URL;
  try {
    destination = new URL(input.url);
    trustedAudience = new URL(input.audience);
  } catch {
    throw new Error(`${urlSetting} and ${audienceSetting} must be valid URLs`);
  }

  const hasCredentials =
    destination.username ||
    destination.password ||
    trustedAudience.username ||
    trustedAudience.password;
  if (
    destination.protocol !== "https:" ||
    trustedAudience.protocol !== "https:" ||
    destination.origin !== trustedAudience.origin ||
    hasCredentials
  ) {
    throw new Error(`${urlSetting} must use HTTPS and match the ${audienceSetting} origin`);
  }
}

function resolveTokenRefreshAt(token: string): number {
  try {
    const { exp } = decodeJwt(token);
    if (!exp) {
      throw new Error("missing exp");
    }
    return Math.max(Date.now(), exp * 1000 - 60_000);
  } catch {
    // Metadata identity tokens currently live for an hour. A short fallback
    // cache avoids per-RPC metadata calls without assuming that full lifetime.
    return Date.now() + 5 * 60_000;
  }
}
