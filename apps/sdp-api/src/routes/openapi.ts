/**
 * OpenAPI Spec Route
 */

import { Hono } from "hono";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";

const openapi = new Hono<{ Bindings: Env }>();

const document = createPublicOpenApiDocument();
const documentBody = JSON.stringify(document);

export function createWeakEtag(value: string): string {
  let hash = 2_166_136_261;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return `W/"${(hash >>> 0).toString(16)}-${bytes.length}"`;
}

const documentEtag = createWeakEtag(documentBody);
const documentOpaqueTag = documentEtag.replace(/^W\//, "");
const OPENAPI_CACHE_CONTROL = [
  "public",
  `max-age=${60 * 60}`,
  `s-maxage=${24 * 60 * 60}`,
  `stale-while-revalidate=${7 * 24 * 60 * 60}`,
  `stale-if-error=${7 * 24 * 60 * 60}`,
].join(", ");

function hasMatchingEtag(ifNoneMatch: string | undefined): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized.replace(/^W\//i, "") === documentOpaqueTag;
  });
}

openapi.get("/", (c) => {
  c.header("Cache-Control", OPENAPI_CACHE_CONTROL);
  c.header("ETag", documentEtag);

  if (hasMatchingEtag(c.req.header("If-None-Match"))) {
    return c.body(null, 304);
  }

  // Do not set Content-Length here: development pretty-printing and Node
  // compression both transform this body later in the middleware stack.
  c.header("Content-Type", "application/json; charset=UTF-8");
  return c.body(documentBody);
});

export default openapi;
