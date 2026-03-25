const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function parseBooleanEnv(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }

  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }

  return null;
}

export function getDefaultAuthEntryEnabled(): boolean {
  const configured = parseBooleanEnv(process.env.SDP_AUTH_ENTRY_ENABLED);

  if (configured !== null) {
    return configured;
  }

  // Vercel preview deployments stay open by default, but production stays closed
  // until onboarding is intentionally enabled.
  return process.env.VERCEL_ENV !== "production";
}
