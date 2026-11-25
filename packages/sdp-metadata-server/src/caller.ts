const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const METADATA_TIMEOUT_MS = 10_000;

/**
 * How long a fetched identity token is sent before a new one is fetched. Google fixes the token's
 * lifetime at an hour, so a receiver that wants a shorter one refuses tokens past an age of its
 * own; that age has to stay above this number.
 */
export const IDENTITY_TOKEN_REFETCH_AFTER_SECONDS = 240;

/** Audience to the token being sent to it. Holding the promise shares one fetch between callers. */
const heldTokens = new Map<string, { token: Promise<string>; fetchedAt: number }>();

/**
 * The identity token to send to one private Cloud Run service.
 *
 * @param destination - The service's URL and audience, and the names of the settings they come
 * from. Throws unless both are HTTPS URLs on one origin, so a token is never sent anywhere but
 * the service it was issued for.
 * @returns A function giving the token to send now.
 */
export function createIdentityTokenProvider(destination: {
  url: string;
  audience: string;
  urlSetting: string;
  audienceSetting: string;
}): () => Promise<string> {
  assertDestinationMatchesAudience(destination);
  const { audience } = destination;

  return () => {
    const held = heldTokens.get(audience);
    if (held && Date.now() - held.fetchedAt < IDENTITY_TOKEN_REFETCH_AFTER_SECONDS * 1000) {
      return held.token;
    }
    // Aged from before the request, so the held token is never younger than this says.
    const fetched = { token: fetchIdentityToken(audience), fetchedAt: Date.now() };
    heldTokens.set(audience, fetched);
    fetched.token.catch(() => {
      if (heldTokens.get(audience) === fetched) heldTokens.delete(audience);
    });
    return fetched.token;
  };
}

async function fetchIdentityToken(audience: string): Promise<string> {
  const endpoint = new URL(METADATA_IDENTITY_URL);
  endpoint.searchParams.set("audience", audience);
  endpoint.searchParams.set("format", "full");
  // Bounded because the fetch is shared: a stalled one would hold every caller for this audience.
  // The signal also bounds the body read below.
  const response = await fetch(endpoint, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Identity token request failed with HTTP ${response.status}`);
  }

  const token = (await response.text()).trim();
  if (!token) {
    throw new Error("Identity token response was empty");
  }
  return token;
}

function assertDestinationMatchesAudience(input: {
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
