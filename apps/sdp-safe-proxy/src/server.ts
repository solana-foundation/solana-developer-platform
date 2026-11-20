import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { parseSettings, SettingsError } from "./settings";

function main(): void {
  let settings: ReturnType<typeof parseSettings>;
  try {
    settings = parseSettings(process.env);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const server = serve({ fetch: createApp().fetch, port: settings.port });
  process.on("SIGTERM", () => server.close());
}

main();
