import { renderLlmsTxt } from "@sdp/api-catalog/ai-discovery";
import type { SdpReleaseChannel } from "@sdp/types/release-channels";
import { Hono } from "hono";
import { deploymentReleaseChannel } from "@/lib/feature-flags";
import { publicRoute } from "@/middleware/require-action";
import { createPublicOpenApiDocument } from "@/openapi/spec";
import type { Env } from "@/types/env";

export const llms = new Hono<{ Bindings: Env }>();

function renderBody(releaseChannel: SdpReleaseChannel): string {
  return renderLlmsTxt({
    audience: "api",
    document: createPublicOpenApiDocument({ releaseChannel }),
  });
}

/** One body per release channel, built on first request from that channel's document. */
const bodies = new Map<SdpReleaseChannel, string>();

llms.get("/", publicRoute("AI discovery resource"), (c) => {
  const releaseChannel = deploymentReleaseChannel();
  let body = bodies.get(releaseChannel);
  if (body === undefined) {
    body = renderBody(releaseChannel);
    bodies.set(releaseChannel, body);
  }
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(body);
});
