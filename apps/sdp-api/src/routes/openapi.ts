/**
 * OpenAPI Spec Route
 */

import { createOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";
import { Hono } from "hono";

const openapi = new Hono<{ Bindings: Env }>();

const document = createOpenApiDocument();

openapi.get("/", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(document);
});

export default openapi;
