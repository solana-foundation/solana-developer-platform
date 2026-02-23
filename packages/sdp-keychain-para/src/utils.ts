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

export function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = normalizeHex(hex);
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    const value = Number.parseInt(normalized.slice(i, i + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid hex data");
    }
    bytes[i / 2] = value;
  }

  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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
