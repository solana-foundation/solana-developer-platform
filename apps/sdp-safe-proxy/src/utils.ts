import { z } from "zod";

export const positiveInteger = z.coerce.number().int().positive();

// Reads the named settings from the environment. A failure names the settings, never a value.
export function readEnv<Settings extends z.ZodRawShape>(
  settings: Settings
): z.infer<z.ZodObject<Settings>> {
  const parsed = z.object(settings).safeParse(process.env);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  throw new Error(`invalid settings: ${names.join(", ")}`);
}

// The provider's own path and query: what follows `/<provider>` in the URL as it was sent, or
// null when the URL does not begin with that provider. Cut from the sent URL, not from decoded
// route parameters, because this one string is matched, signed and forwarded.
export function providerTarget(url: string, provider: string): string | null {
  const { pathname, search } = new URL(url);
  if (!pathname.startsWith(`/${provider}/`)) return null;
  return pathname.slice(provider.length + 1) + search;
}
