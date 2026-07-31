/**
 * Whether to expose developer-only controls: switches that exist for us to tune a
 * design, not for customers to operate. Local development, `test`, and Vercel
 * preview/development builds qualify; anything production-like does not.
 *
 * Deliberately not a Vercel flag. Product rollouts live in `src/flags.ts` so they
 * can be flipped per environment or per user from the flags dashboard — these are
 * our own tooling, and a switch that can turn them on in production is exactly
 * what this is meant to prevent.
 */
export function isDeveloperControlsEnabled({
  nodeEnvironment,
  sdpEnvironment,
  vercelEnvironment,
}: {
  nodeEnvironment?: string;
  sdpEnvironment?: string;
  vercelEnvironment?: string;
}): boolean {
  const vercel = normalize(vercelEnvironment);
  if (vercel) {
    return vercel === "preview" || vercel === "development";
  }

  const sdp = normalize(sdpEnvironment);
  if (sdp) {
    return sdp === "development";
  }

  const node = normalize(nodeEnvironment);
  return node === "development" || node === "test";
}

function normalize(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}
