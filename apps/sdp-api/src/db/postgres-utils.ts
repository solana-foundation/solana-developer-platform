export function asPostgresJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

export function asPostgresJsonArray(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>[];
  }
  return value as Record<string, unknown>[];
}
