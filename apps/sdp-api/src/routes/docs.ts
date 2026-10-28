/**
 * OpenAPI Docs UI Route
 */

import { Hono } from "hono";
import { publicRoute } from "@/middleware/require-action";
import type { Env } from "@/types/env";

export const docs = new Hono<{ Bindings: Env }>();

/**
 * The exact version and subresource-integrity hashes of the two Swagger UI
 * files the docs page loads from unpkg. Pinned so a compromised or poisoned
 * CDN response cannot run script on this origin: the browser refuses anything
 * whose bytes do not match. To upgrade, fetch the new files, hash them, and
 * update both pins together.
 */
const SWAGGER_UI_VERSION = "5.34.0";
// Integrity hashes are public values by design, not secrets.
const SWAGGER_UI_CSS_SRI =
  // biome-ignore lint/security/noSecrets: a subresource-integrity hash, not a secret
  "sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF";
const SWAGGER_UI_BUNDLE_SRI =
  // biome-ignore lint/security/noSecrets: a subresource-integrity hash, not a secret
  "sha384-9Td7MKiIr2S83E1kZyyVi8KdJw/S8CpAvu0llLyMeg0xq/hDGiZJfVn0fV4llCmK";

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SDP API Docs</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css"
      integrity="${SWAGGER_UI_CSS_SRI}"
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
      src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js"
      integrity="${SWAGGER_UI_BUNDLE_SRI}"
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
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(html);
});
