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

export function createOpenApiDocument(): OpenAPIObject {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", "apiKeyAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "API Key",
    description:
      "Use Authorization: Bearer sk_test_... or sk_live_... with a base64url-encoded suffix.",
  });

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

  registry.registerComponent("securitySchemes", "organizationRegistrationToken", {
    type: "apiKey",
    in: "header",
    name: "x-organization-registration-token",
    description: "Pre-shared token required for organization self-registration.",
  });

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

  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Solana Developer Platform API",
      version: "0.1.0",
      description:
        "Production-only OpenAPI spec generated from API schemas and routes. API versioning is path-based: /v1 is the current contract, and breaking changes are introduced under a new path major (for example /v2). The OpenAPI info.version tracks spec/document revision for the current path contract.",
    },
    tags: [
      { name: "Health", description: "Service health and readiness endpoints." },
      { name: "Organizations", description: "Organization provisioning and settings." },
      { name: "API Keys", description: "API key management endpoints." },
      { name: "Members", description: "Organization membership invitations and roles." },
      { name: "Auth", description: "Session authentication and management." },
      {
        name: "Wallets",
        description: "Wallet signing provider configuration and wallet management.",
      },
      { name: "Projects", description: "Project and project member management." },
      { name: "RPC", description: "Managed Solana RPC relay and provider telemetry." },
      { name: "Issuance", description: "Token issuance, allowlists, and lifecycle operations." },
      {
        name: "Payments",
        description: "Wallet balances, transfer execution, policies, and ramps.",
      },
      { name: "Compliance", description: "Risk and compliance screening endpoints." },
      { name: "Admin", description: "Administrative allowlist management." },
      { name: "Onboarding", description: "Clerk organization sync status." },
    ],
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
