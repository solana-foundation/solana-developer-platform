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

function getLegacyAuthEntryEnabled(): boolean | null {
  const configured = parseBooleanEnv(process.env.SDP_AUTH_ENTRY_ENABLED);

  return configured;
}

function getDefaultEntryEnabled(envName: "SDP_SIGN_IN_ENTRY_ENABLED" | "SDP_SIGN_UP_ENTRY_ENABLED") {
  const configured = parseBooleanEnv(process.env[envName]);

  if (configured !== null) {
    return configured;
  }

  const legacyConfigured = getLegacyAuthEntryEnabled();
  if (legacyConfigured !== null) {
    return legacyConfigured;
  }

  // Vercel preview deployments stay open by default, but production stays closed
  // until onboarding is intentionally enabled.
  return process.env.VERCEL_ENV !== "production";
}

export function getDefaultSignInEntryEnabled(): boolean {
  return getDefaultEntryEnabled("SDP_SIGN_IN_ENTRY_ENABLED");
}

export function getDefaultSignUpEntryEnabled(): boolean {
  return getDefaultEntryEnabled("SDP_SIGN_UP_ENTRY_ENABLED");
}
