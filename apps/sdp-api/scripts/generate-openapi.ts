import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveSdpReleaseChannel } from "@sdp/types/release-channels";

import { createPublicOpenApiDocument, createPublicSurfaceManifest } from "@/openapi/spec";

// The docs build sets SDP_RELEASE_CHANNEL so each deployment documents only the
// modules it runs. Unset (local runs, CI drift checks), it documents every
// module, which is what the committed docs artifacts hold. A Vercel build must
// set it, like sdp-web, so a forgotten variable cannot publish every module.
if (process.env.VERCEL && !process.env.SDP_RELEASE_CHANNEL) {
  throw new Error("SDP_RELEASE_CHANNEL is required on Vercel (one of experimental, beta, stable)");
}
const releaseChannel = resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL || "experimental");
const document = createPublicOpenApiDocument({ releaseChannel });

const outputDir = path.resolve(process.cwd(), "generated");
const outputPath = path.join(outputDir, "openapi.json");

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
// The docs build copies this next to its content (sdp-docs generate:api).
await writeFile(
  path.join(outputDir, "public-surface.json"),
  `${JSON.stringify(createPublicSurfaceManifest(releaseChannel), null, 2)}\n`,
  "utf8"
);

console.log(`OpenAPI spec (${releaseChannel}) generated at ${outputPath}`);
