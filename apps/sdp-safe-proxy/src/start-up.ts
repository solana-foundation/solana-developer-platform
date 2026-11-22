export function exitWithMessage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// A settings failure names the settings and stops the process.
export function settingsOrExit<Settings>(
  parse: (env: Record<string, string | undefined>) => Settings
): Settings {
  try {
    return parse(process.env);
  } catch (error) {
    return exitWithMessage(error instanceof Error ? error.message : "invalid settings");
  }
}
