import { z } from "zod";
import type { Command } from "./commands";

const flags = {
  "include-headers": {
    type: "boolean",
    description:
      "Wrap a successful response as {status, headers, body}; exposes ETag and cache policy",
  },
} as const;
export const discoveryCommands: readonly Command[] = [
  { words: ["health", "check"], operationId: "healthCheck", flags },
  { words: ["health", "readiness"], operationId: "healthReadiness", flags },
  {
    words: ["api", "openapi", "get"],
    operationId: "getApiOpenApiDocument",
    flags: {
      ...flags,
      "if-none-match": {
        type: "string",
        description:
          "Captured document ETag, validator list, or *; a match reports 304 without a cached body",
      },
    },
  },
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  { words: ["api", "docs", "get"], operationId: "getApiDocsPage", flags },
  { words: ["api", "ai-discovery", "get"], operationId: "getApiAiDiscovery", flags },
  { words: ["api", "root-redirect", "get"], operationId: "getApiRoot", flags },
];
export const discoveryOptionFields = {
  "include-headers": z.boolean().optional(),
  "if-none-match": z.string().optional(),
};
