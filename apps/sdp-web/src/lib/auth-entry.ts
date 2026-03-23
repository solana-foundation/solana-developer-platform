const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function parseBooleanEnv(value: string | undefined): boolean | null {
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

export function isAuthEntryEnabled(): boolean {
  const configured = parseBooleanEnv(process.env.SDP_AUTH_ENTRY_ENABLED);

  if (configured !== null) {
    return configured;
  }

  return process.env.VERCEL_ENV !== "production";
}

export function getAuthEntryPath(): string {
  return isAuthEntryEnabled() ? "/sign-in" : "/";
}

export function shouldLoadClerkForPath(pathname: string): boolean {
  if (isAuthEntryEnabled()) {
    return true;
  }

  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/allowlist" ||
    pathname.startsWith("/allowlist/") ||
    pathname === "/members" ||
    pathname.startsWith("/members/")
  );
}
