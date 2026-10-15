/**
 * OpenAPI Spec Route
 */

import { resolveSdpReleaseChannel, type SdpReleaseChannel } from "@sdp/types";
import { Hono } from "hono";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";

const openapi = new Hono<{ Bindings: Env }>();

export function createWeakEtag(value: string): string {
  let hash = 2_166_136_261;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return `W/"${(hash >>> 0).toString(16)}-${bytes.length}"`;
}

type ServedDocument = { body: string; etag: string; opaqueTag: string };

/** One pre-serialized document per release channel, built on first request. */
const servedDocuments = new Map<SdpReleaseChannel, ServedDocument>();

/**
 * The public document for this deployment's release channel, so the API never
 * documents a route it refuses with 403.
 */
function servedDocument(releaseChannel: SdpReleaseChannel): ServedDocument {
  let served = servedDocuments.get(releaseChannel);
  if (!served) {
    const body = JSON.stringify(createPublicOpenApiDocument({ releaseChannel }));
    const etag = createWeakEtag(body);
    served = { body, etag, opaqueTag: etag.replace(/^W\//, "") };
    servedDocuments.set(releaseChannel, served);
  }
  return served;
}
const OPENAPI_CACHE_CONTROL = [
  "public",
  `max-age=${60 * 60}`,
  `s-maxage=${24 * 60 * 60}`,
  `stale-while-revalidate=${7 * 24 * 60 * 60}`,
  `stale-if-error=${7 * 24 * 60 * 60}`,
].join(", ");

function hasMatchingEtag(ifNoneMatch: string | undefined, documentOpaqueTag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized.replace(/^W\//i, "") === documentOpaqueTag;
  });
}

openapi.get("/", (c) => {
  const document = servedDocument(resolveSdpReleaseChannel(c.env.SDP_RELEASE_CHANNEL));
  c.header("Cache-Control", OPENAPI_CACHE_CONTROL);
  c.header("ETag", document.etag);

  if (hasMatchingEtag(c.req.header("If-None-Match"), document.opaqueTag)) {
    return c.body(null, 304);
  }

  // Do not set Content-Length here: development pretty-printing and Node
  // compression both transform this body later in the middleware stack.
  c.header("Content-Type", "application/json; charset=UTF-8");
  return c.body(document.body);
});

export default openapi;
