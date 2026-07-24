export function setNestedValue(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let current: Record<string, unknown> = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      return;
    }

    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }

    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }
}
