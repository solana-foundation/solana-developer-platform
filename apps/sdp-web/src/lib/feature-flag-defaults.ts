type RuntimeFlagEnvironment = {
  nodeEnvironment?: string;
  sdpEnvironment?: string;
  vercelEnvironment?: string;
};

function normalize(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

export function getHomepageOpenSignupDefault({
  vercelEnvironment,
}: Pick<RuntimeFlagEnvironment, "vercelEnvironment">): boolean {
  // Preserve open signup for non-Vercel/self-hosted deployments. Vercel
  // production is the only environment that should fail back to the waitlist.
  return normalize(vercelEnvironment) !== "production";
}

export function getAssetProfilesDefault({
  nodeEnvironment,
  sdpEnvironment,
  vercelEnvironment,
}: RuntimeFlagEnvironment): boolean {
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
