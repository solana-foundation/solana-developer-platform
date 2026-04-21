/**
 * OpenAPI Spec Route
 */

import { Hono } from "hono";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";

const openapi = new Hono<{ Bindings: Env }>();

const document = createPublicOpenApiDocument();

openapi.get("/", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(document);
});

export default openapi;
