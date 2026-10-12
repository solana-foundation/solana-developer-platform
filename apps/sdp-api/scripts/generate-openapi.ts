import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveSdpReleaseChannel } from "@sdp/types";

import { createPublicOpenApiDocument } from "../src/openapi/spec";

// The docs build sets SDP_RELEASE_CHANNEL so each deployment documents only the
// modules it runs. Unset (local runs, CI drift checks), it documents every
// module, which is what the committed docs artifacts hold.
const releaseChannel = resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL || "experimental");
const document = createPublicOpenApiDocument({ releaseChannel });

const outputDir = path.resolve(process.cwd(), "generated");
const outputPath = path.join(outputDir, "openapi.json");

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`OpenAPI spec (${releaseChannel}) generated at ${outputPath}`);
