const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function setNestedValue(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    return;
  }

  let current: Record<string, unknown> = target;

  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }

    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  });
}
