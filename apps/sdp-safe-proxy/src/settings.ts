import { z } from "zod";

const settingsSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
});

export type Settings = {
  port: number;
};

export class SettingsError extends Error {
  constructor(setting: string, problem: "missing" | "invalid") {
    // Names the setting, never its value.
    super(`${setting} is ${problem}`);
    this.name = "SettingsError";
  }
}

export function parseSettings(env: Record<string, string | undefined>): Settings {
  if (env.PORT === undefined || env.PORT === "") throw new SettingsError("PORT", "missing");
  const parsed = settingsSchema.safeParse(env);
  if (!parsed.success) throw new SettingsError("PORT", "invalid");
  return { port: parsed.data.PORT };
}
