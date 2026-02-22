export function resolveRequestUrl(
  apiBaseUrl: string,
  path: string
): {
  requestPath: string;
  url: URL;
} {
  const normalizedBaseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBaseUrl);
  return {
    requestPath: `${url.pathname}${url.search}`,
    url,
  };
}

export function requiresWalletAuth(method: string, requestPath: string): boolean {
  if (!["POST", "PUT", "DELETE"].includes(method.toUpperCase())) {
    return false;
  }

  return requestPath.includes("/accounts") || requestPath.includes("/spend-permissions");
}

export function sortJsonKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeys(item)) as T;
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }

  return value;
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isPemEncodedKey(value: string): boolean {
  return value.includes("-----BEGIN");
}

export function getNestedProp<T>(value: unknown, ...paths: string[]): T | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path.split(".")) {
      if (!current || typeof current !== "object" || !(segment in current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    if (current !== undefined) {
      return current as T;
    }
  }

  return undefined;
}
