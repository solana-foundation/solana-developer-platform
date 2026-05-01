import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient } from "../src/db";
import { ClerkOrganizationsService } from "../src/services/clerk-organizations.service";
import {
  parseProviderOverridesFromClerkMetadata,
  syncProviderAccessFromClerk,
} from "../src/services/provider-availability.service";
import type { Env } from "../src/types/env";

type Tier = "individual" | "enterprise";

function loadLocalEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8");
  const values: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!key) {
      continue;
    }

    values[key] = rest.join("=");
  }

  return values;
}

function readArg(flag: string): string | undefined {
  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }

  return process.argv[flagIndex + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseTier(value: string | undefined): Tier {
  if (value === "individual" || value === "enterprise") {
    return value;
  }

  throw new Error("Missing or invalid --tier value. Use 'individual' or 'enterprise'.");
}

function parseOverrides(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Invalid --overrides JSON: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  const overrides = parseProviderOverridesFromClerkMetadata(parsed);
  if (!overrides) {
    throw new Error(
      "The provided --overrides JSON did not contain any valid provider override entries."
    );
  }

  return overrides;
}

function buildDefaultDatabaseUrl(): string {
  const url = new URL("postgresql://127.0.0.1:5432/sdp");
  url.username = "sdp";
  url.password = "sdp";
  return url.toString();
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appDir = path.resolve(scriptDir, "..");
  const localEnv = loadLocalEnvFile(path.join(appDir, ".dev.vars"));
  const runtimeEnv = {
    ...localEnv,
    ...process.env,
  };

  const listOnly = hasFlag("--list");
  const clerkOrgId = readArg("--clerk-org-id")?.trim();
  const tierArg = readArg("--tier")?.trim();
  const overridesArg = readArg("--overrides")?.trim();
  const databaseUrl = runtimeEnv.DATABASE_URL?.trim() ?? buildDefaultDatabaseUrl();

  const db = createDatabaseClient(databaseUrl);

  if (listOnly) {
    const mappings = await db
      .prepare(
        `SELECT a.provider_org_id AS "clerkOrgId",
                o.id AS "organizationId",
                o.slug AS "organizationSlug",
                o.name AS "organizationName",
                o.tier AS "tier",
                o.status AS "status"
         FROM auth_organization_identities a
         JOIN organizations o ON o.id = a.organization_id
         WHERE a.provider = 'clerk'
         ORDER BY o.updated_at DESC, o.created_at DESC`
      )
      .all<{
        clerkOrgId: string;
        organizationId: string;
        organizationSlug: string;
        organizationName: string;
        tier: string;
        status: string;
      }>();

    console.log(JSON.stringify({ mappings: mappings.results }, null, 2));
    return;
  }

  const tier = parseTier(tierArg);
  const providerOverrides = parseOverrides(overridesArg);

  if (!clerkOrgId) {
    throw new Error(
      "Missing --clerk-org-id. Example: --clerk-org-id org_123. Use --list to discover local mappings."
    );
  }

  if (!runtimeEnv.CLERK_SECRET_KEY?.trim()) {
    throw new Error("CLERK_SECRET_KEY is required. Add it to apps/sdp-api/.dev.vars first.");
  }

  const clerkService = new ClerkOrganizationsService(runtimeEnv as Env);

  const currentClerkOrganization = await clerkService.getOrganization(clerkOrgId);
  const currentPrivateMetadata =
    currentClerkOrganization.private_metadata &&
    typeof currentClerkOrganization.private_metadata === "object"
      ? currentClerkOrganization.private_metadata
      : {};
  const currentSdpMetadata =
    currentPrivateMetadata.sdp && typeof currentPrivateMetadata.sdp === "object"
      ? currentPrivateMetadata.sdp
      : {};

  const nextPrivateMetadata = {
    ...currentPrivateMetadata,
    sdp: {
      ...currentSdpMetadata,
      tier,
      ...(providerOverrides ? { providerOverrides } : {}),
      ...(providerOverrides ? {} : { providerOverrides: undefined }),
    },
  };

  if (!providerOverrides && "providerOverrides" in nextPrivateMetadata.sdp) {
    nextPrivateMetadata.sdp.providerOverrides = undefined;
  }

  const mapping = await db
    .prepare(
      `SELECT organization_id
       FROM auth_organization_identities
       WHERE provider = 'clerk' AND provider_org_id = ?`
    )
    .bind(clerkOrgId)
    .first<{ organization_id: string }>();

  if (!mapping) {
    throw new Error(
      `No local SDP organization mapping found for Clerk org '${clerkOrgId}'. Link the org locally first.`
    );
  }

  const updatedClerkOrganization = await clerkService.updateOrganizationPrivateMetadata(
    clerkOrgId,
    nextPrivateMetadata
  );
  const synced = await syncProviderAccessFromClerk(db, {
    organizationId: mapping.organization_id,
    clerkOrganization: updatedClerkOrganization,
  });

  const access = await db
    .prepare(
      `SELECT id, tier, settings
       FROM organizations
       WHERE id = ?`
    )
    .bind(mapping.organization_id)
    .first<{ id: string; tier: string; settings: string | null }>();

  console.log(
    JSON.stringify(
      {
        clerkOrgId,
        organizationId: mapping.organization_id,
        requested: {
          tier,
          providerOverrides: providerOverrides ?? null,
        },
        synced,
        persisted: access
          ? {
              id: access.id,
              tier: access.tier,
              settings: access.settings ? JSON.parse(access.settings) : null,
            }
          : null,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
