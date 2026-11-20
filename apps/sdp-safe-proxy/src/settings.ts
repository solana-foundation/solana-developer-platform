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
  const rawPort = env.PORT;
  if (rawPort === undefined || rawPort === "") throw new SettingsError("PORT", "missing");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsError("PORT", "invalid");
  }
  return { port };
}
