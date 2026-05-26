import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { DEFAULT_SDP_API_URL } from "@sdp/types";
import type { OpenAPIObject } from "openapi3-ts/oas30";

import { registerAdminPaths } from "./paths/admin";
import { registerApiKeyPaths } from "./paths/api-keys";
import { registerAuthPaths } from "./paths/auth";
import { registerCompliancePaths } from "./paths/compliance";
import { registerCounterpartyPaths } from "./paths/counterparties";
import { registerCustodyPaths } from "./paths/custody";
import { registerHealthPaths } from "./paths/health";
import { registerIssuancePaths } from "./paths/issuance";
import { registerMemberPaths } from "./paths/members";
import { registerOnboardingPaths } from "./paths/onboarding";
import { registerOrganizationPaths } from "./paths/organizations";
import { registerPaymentsPaths } from "./paths/payments";
import { registerProjectPaths } from "./paths/projects";
import { registerRpcPaths } from "./paths/rpc";

const OPENAPI_TAG = {
  HEALTH: { name: "Health", description: "Service health and readiness endpoints." },
  ORGANIZATIONS: { name: "Organizations", description: "Organization provisioning and settings." },
  API_KEYS: { name: "API Keys", description: "API key management endpoints." },
  MEMBERS: { name: "Members", description: "Organization membership invitations and roles." },
  AUTH: { name: "Auth", description: "Session authentication and management." },
  WALLETS: {
    name: "Wallets",
    description: "Wallet signing provider configuration and wallet management.",
  },
  PROJECTS: { name: "Projects", description: "Project and project member management." },
  RPC: { name: "RPC", description: "Managed Solana RPC relay and provider telemetry." },
  ISSUANCE: {
    name: "Issuance",
    description: "Token issuance, allowlists, and lifecycle operations.",
  },
  PAYMENTS: {
    name: "Payments",
    description: "Wallet balances, transfer execution, policies, and ramps.",
  },
  COMPLIANCE: { name: "Compliance", description: "Risk and compliance screening endpoints." },
  COUNTERPARTIES: {
    name: "Counterparties",
    description: "Counterparty (customer/beneficiary) identity records.",
  },
  ADMIN: { name: "Admin", description: "Administrative allowlist management." },
  ONBOARDING: { name: "Onboarding", description: "Clerk organization sync status." },
} as const;

const PUBLIC_OPENAPI_TAGS = [
  OPENAPI_TAG.HEALTH,
  OPENAPI_TAG.API_KEYS,
  OPENAPI_TAG.WALLETS,
  OPENAPI_TAG.PROJECTS,
  OPENAPI_TAG.ISSUANCE,
  OPENAPI_TAG.PAYMENTS,
  OPENAPI_TAG.COMPLIANCE,
  OPENAPI_TAG.COUNTERPARTIES,
];

const OPENAPI_TAGS = [
  OPENAPI_TAG.HEALTH,
  OPENAPI_TAG.ORGANIZATIONS,
  OPENAPI_TAG.API_KEYS,
  OPENAPI_TAG.MEMBERS,
  OPENAPI_TAG.AUTH,
  OPENAPI_TAG.WALLETS,
  OPENAPI_TAG.PROJECTS,
  OPENAPI_TAG.RPC,
  OPENAPI_TAG.ISSUANCE,
  OPENAPI_TAG.PAYMENTS,
  OPENAPI_TAG.COMPLIANCE,
  OPENAPI_TAG.COUNTERPARTIES,
  OPENAPI_TAG.ADMIN,
  OPENAPI_TAG.ONBOARDING,
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
  registerCounterpartyPaths(registry);
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
  registerCounterpartyPaths(registry);
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
