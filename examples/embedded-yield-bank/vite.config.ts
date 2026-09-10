import path from "node:path";
import { defineConfig } from "vite";
import { DEMO_SESSION_HEADER } from "./server/demo-session";

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const sessionToken = process.env.NORTHSTAR_DEMO_SESSION_TOKEN;
  if (command === "serve" && mode !== "test" && !sessionToken) {
    throw new Error(
      "Start Northstar with `pnpm dev:example:embedded-yield` so its local session is authorized"
    );
  }

  return {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: createApiProxy(sessionToken),
    },
    preview: {
      proxy: createApiProxy(sessionToken),
    },
  };
});

function createApiProxy(sessionToken: string | undefined) {
  return {
    "/api": {
      target: "http://127.0.0.1:4174",
      configure(proxy: {
        on(
          event: "proxyReq",
          listener: (proxyRequest: {
            setHeader(name: string, value: string): void;
          }) => void
        ): void;
      }) {
        proxy.on("proxyReq", (proxyRequest) => {
          if (sessionToken)
            proxyRequest.setHeader(DEMO_SESSION_HEADER, sessionToken);
        });
      },
    },
  };
}
