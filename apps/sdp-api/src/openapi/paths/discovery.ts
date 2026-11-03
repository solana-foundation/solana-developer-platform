/** Existing discovery routes; internal documentation does not promote API families. */
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { errorResponseSchema } from "@/openapi/schemas/base";
import { errorResponses, jsonContent } from "./helpers";

const publicDocument = z
  .object({
    openapi: z.literal("3.0.3"),
    info: z.object({ title: z.string(), version: z.string() }).passthrough(),
    paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .passthrough();
const cacheHeaders = z.object({
  ETag: z.string().min(1).openapi({ description: "Deployment-channel document validator." }),
  "Cache-Control": z.string().openapi({ description: "Public document cache policy." }),
});
const errors = errorResponses(errorResponseSchema, [429, 500]);
export function registerDiscoveryPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/openapi.json",
    tags: ["API Discovery"],
    operationId: "getApiOpenApiDocument",
    summary: "Read the deployment's public OpenAPI document",
    description:
      "Fetches the public OpenAPI JSON served by this deployment's release channel. Publication holds and module/provider filtering are server-owned; the CLI neither merges its internal contract nor substitutes another channel. Requires no authentication or project. If-None-Match accepts a captured ETag, a validator list, or *. A matching validator returns an empty 304; the CLI reports notModified without inventing a cached document. --include-headers exposes the ETag and cache policy. One request, without retries or following redirects.",
    security: [],
    request: {
      headers: z.object({
        "If-None-Match": z
          .string()
          .min(1)
          .regex(/^[\x20-\x7E]+$/)
          .optional(),
      }),
    },
    responses: {
      200: {
        description: "Public OpenAPI document for this deployment",
        headers: cacheHeaders,
        content: jsonContent(publicDocument),
      },
      304: { description: "Validator matches; no response body", headers: cacheHeaders },
      ...errors,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/docs",
    tags: ["API Discovery"],
    operationId: "getApiDocsPage",
    summary: "Read the Swagger UI HTML page",
    description:
      "Fetches the API's Swagger UI HTML as a JSON string. Does not execute HTML, open a browser, or fetch referenced scripts, stylesheets, or the OpenAPI document. Requires no authentication or project. One request without retries or following redirects.",
    security: [],
    responses: {
      200: {
        description: "Swagger UI HTML",
        content: { "text/html": { schema: z.string().min(1) } },
      },
      ...errors,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/llms.txt",
    tags: ["API Discovery"],
    operationId: "getApiAiDiscovery",
    summary: "Read the deployment's AI discovery resource",
    description:
      "Fetches the API's plain-text AI discovery resource as a JSON string. Its families come from this deployment's public OpenAPI document and retain its release-channel and publication restrictions. Does not fetch links or substitute the docs site's discovery files. Requires no authentication or project. One request without retries or following redirects.",
    security: [],
    responses: {
      200: {
        description: "AI discovery text",
        content: { "text/plain": { schema: z.string().min(1) } },
      },
      ...errors,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/",
    tags: ["API Discovery"],
    operationId: "getApiRoot",
    summary: "Inspect the root redirect",
    description:
      "Reads the API root and reports its 302 status and Location (/health) without following the redirect. Requires no authentication or project. Makes one request without retries.",
    security: [],
    responses: {
      302: {
        description: "Redirect to health",
        headers: z.object({ Location: z.literal("/health") }),
      },
      ...errors,
    },
  });
}
