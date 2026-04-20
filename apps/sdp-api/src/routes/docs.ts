/**
 * OpenAPI Docs UI Route
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";

const docs = new Hono<{ Bindings: Env }>();

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SDP API Docs</title>
    <link
      rel="stylesheet"
      href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"
    />
    <style>
      html, body { margin: 0; padding: 0; }
      #swagger-ui { height: 100vh; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
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

docs.get("/", (c) => {
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(html);
});

export default docs;
