import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { DEFAULT_SDP_API_URL } from "@sdp/types";
import type { OpenAPIObject } from "openapi3-ts/oas30";

import { registerAdminPaths } from "./paths/admin";
import { registerApiKeyPaths } from "./paths/api-keys";
import { registerAuthPaths } from "./paths/auth";
import { registerCompliancePaths } from "./paths/compliance";
import { registerCustodyPaths } from "./paths/custody";
import { registerHealthPaths } from "./paths/health";
import { registerIssuancePaths } from "./paths/issuance";
import { registerMemberPaths } from "./paths/members";
import { registerOnboardingPaths } from "./paths/onboarding";
import { registerOrganizationPaths } from "./paths/organizations";
import { registerPaymentsPaths } from "./paths/payments";
import { registerProjectPaths } from "./paths/projects";
import { registerRpcPaths } from "./paths/rpc";

const PUBLIC_OPENAPI_TAGS = [
  { name: "Health", description: "Service health and readiness endpoints." },
  { name: "API Keys", description: "API key management endpoints." },
  {
    name: "Wallets",
    description: "Wallet signing provider configuration and wallet management.",
  },
  { name: "Projects", description: "Project and project member management." },
  { name: "Issuance", description: "Token issuance, allowlists, and lifecycle operations." },
  {
    name: "Payments",
    description: "Wallet balances, transfer execution, policies, and ramps.",
  },
  { name: "Compliance", description: "Risk and compliance screening endpoints." },
];

const INTERNAL_OPENAPI_TAGS = [
  { name: "Organizations", description: "Organization provisioning and settings." },
  { name: "Members", description: "Organization membership invitations and roles." },
  { name: "Auth", description: "Session authentication and management." },
  { name: "RPC", description: "Managed Solana RPC relay and provider telemetry." },
  { name: "Admin", description: "Administrative allowlist management." },
  { name: "Onboarding", description: "Clerk organization sync status." },
];

const OPENAPI_TAGS = [
  PUBLIC_OPENAPI_TAGS[0],
  INTERNAL_OPENAPI_TAGS[0],
  PUBLIC_OPENAPI_TAGS[1],
  INTERNAL_OPENAPI_TAGS[1],
  INTERNAL_OPENAPI_TAGS[2],
  PUBLIC_OPENAPI_TAGS[2],
  PUBLIC_OPENAPI_TAGS[3],
  INTERNAL_OPENAPI_TAGS[3],
  PUBLIC_OPENAPI_TAGS[4],
  PUBLIC_OPENAPI_TAGS[5],
  PUBLIC_OPENAPI_TAGS[6],
  INTERNAL_OPENAPI_TAGS[4],
  INTERNAL_OPENAPI_TAGS[5],
];

function registerApiKeyAuth(registry: OpenAPIRegistry) {
  registry.registerComponent("securitySchemes", "apiKeyAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "API Key",
    description:
      "Use Authorization: Bearer sk_test_... or sk_live_... with a base64url-encoded suffix.",
  });
}

function registerInternalSecuritySchemes(registry: OpenAPIRegistry) {
  registry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "sdp_session",
    description: "Session cookie for dashboard authentication.",
  });

  registry.registerComponent("securitySchemes", "adminKey", {
    type: "apiKey",
    in: "header",
    name: "X-Admin-Key",
    description: "Admin key for internal allowlist management.",
  });
}

function registerPublicPaths(registry: OpenAPIRegistry) {
  registerHealthPaths(registry);
  registerApiKeyPaths(registry);
  registerCustodyPaths(registry);
  registerProjectPaths(registry);
  registerIssuancePaths(registry);
  registerPaymentsPaths(registry);
  registerCompliancePaths(registry);
}

function registerAllPaths(registry: OpenAPIRegistry) {
  registerHealthPaths(registry);
  registerOrganizationPaths(registry);
  registerApiKeyPaths(registry);
  registerMemberPaths(registry);
  registerAuthPaths(registry);
  registerCustodyPaths(registry);
  registerProjectPaths(registry);
  registerRpcPaths(registry);
  registerIssuancePaths(registry);
  registerPaymentsPaths(registry);
  registerCompliancePaths(registry);
  registerAdminPaths(registry);
  registerOnboardingPaths(registry);
}

function createDocument({ publicOnly }: { publicOnly: boolean }): OpenAPIObject {
  const registry = new OpenAPIRegistry();

  registerApiKeyAuth(registry);

  if (publicOnly) {
    registerPublicPaths(registry);
  } else {
    registerInternalSecuritySchemes(registry);
    registerAllPaths(registry);
  }

  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Solana Developer Platform API",
      version: "0.1.0",
      description: publicOnly
        ? "Public OpenAPI spec generated from supported API schemas and routes. API versioning is path-based: /v1 is the current contract, and breaking changes are introduced under a new path major (for example /v2). The OpenAPI info.version tracks spec/document revision for the current path contract."
        : "Production-only OpenAPI spec generated from API schemas and routes. API versioning is path-based: /v1 is the current contract, and breaking changes are introduced under a new path major (for example /v2). The OpenAPI info.version tracks spec/document revision for the current path contract.",
    },
    tags: publicOnly ? PUBLIC_OPENAPI_TAGS : OPENAPI_TAGS,
    servers: [
      {
        url: "http://localhost:8787",
        description: "Local development",
      },
      {
        url: DEFAULT_SDP_API_URL,
        description: "Production",
      },
    ],
  });
}

export function createOpenApiDocument(): OpenAPIObject {
  return createDocument({ publicOnly: false });
}

export function createPublicOpenApiDocument(): OpenAPIObject {
  return createDocument({ publicOnly: true });
}
