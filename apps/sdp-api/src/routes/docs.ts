import { DEFAULT_SDP_API_URL, DEFAULT_SDP_DOCS_URL } from "@sdp/types/site";
import { Hono } from "hono";
import { publicRoute } from "@/middleware/require-action";
import type { Env } from "@/types/env";

export const docs = new Hono<{ Bindings: Env }>();

// One exact Swagger UI release, with the integrity of each file, so the CDN can
// never serve this page code it did not publish for that version. Bumping the
// version means replacing both hashes (unpkg's `?meta` lists them).
const SWAGGER_UI_VERSION = "5.34.0";
// biome-ignore lint/security/noSecrets: a public file digest (SRI), not a secret.
const SWAGGER_UI_CSS_INTEGRITY = "sha256-w8/oJIxLC4lnNgD7gpkk6vusbeS8SysG9fUkNIMHTQo=";
// biome-ignore lint/security/noSecrets: a public file digest (SRI), not a secret.
const SWAGGER_UI_BUNDLE_INTEGRITY = "sha256-P2q/cEgNt+B5FN9MmKdzhfIupYXq9Fej5kFboOri0Wc=";
const SWAGGER_UI_BASE = `https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SDP API Docs</title>
    <link
      rel="stylesheet"
      href="${SWAGGER_UI_BASE}/swagger-ui.css"
      integrity="${SWAGGER_UI_CSS_INTEGRITY}"
      crossorigin="anonymous"
    />
    <style>
      html, body { margin: 0; padding: 0; }
      #swagger-ui { height: 100vh; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script
      src="${SWAGGER_UI_BASE}/swagger-ui-bundle.js"
      integrity="${SWAGGER_UI_BUNDLE_INTEGRITY}"
      crossorigin="anonymous"
    ></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
      });
    </script>
  </body>
</html>
`;

docs.get("/", publicRoute("API reference page"), (c) => {
  if (
    c.env.SDP_RELEASE_CHANNEL === "stable" &&
    new URL(c.req.url).host === new URL(DEFAULT_SDP_API_URL).host
  ) {
    return c.redirect(`${DEFAULT_SDP_DOCS_URL}/reference/api`, 308);
  }
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(html);
});
