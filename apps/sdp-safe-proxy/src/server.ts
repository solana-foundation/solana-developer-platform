import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { parseSettings, type Settings } from "./settings";

function readSettings(): Settings {
  try {
    return parseSettings(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid settings"}\n`);
    process.exit(1);
  }
}

const settings = readSettings();
const server = serve({ fetch: createApp().fetch, port: settings.SDP_SAFE_PROXY_PORT });
process.on("SIGTERM", () => server.close());
