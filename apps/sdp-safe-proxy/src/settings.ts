import { z } from "zod";

const settingsSchema = z.object({
  SDP_SAFE_PROXY_PORT: z.coerce.number().int().min(1).max(65535),
});

export type Settings = z.infer<typeof settingsSchema>;

export function parseSettings(env: Record<string, string | undefined>): Settings {
  const parsed = settingsSchema.safeParse(env);
  if (parsed.success) return parsed.data;
  // Names the settings that failed, never Zod's message or the value.
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  throw new Error(`invalid settings: ${names.join(", ")}`);
}
