export interface KeysetCursor {
  value: string;
  id: string;
}

/** Encode an ordered value and stable row id as an opaque, URL-safe cursor. */
export function encodeKeysetCursor(value: string, id: string): string {
  return btoa(`${value}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the shared cursor envelope; callers remain responsible for value validation. */
export function decodeKeysetCursor(cursor: string): KeysetCursor | null {
  try {
    const decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const separator = decoded.indexOf("|");
    if (separator <= 0 || separator === decoded.length - 1) return null;
    return { value: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}
