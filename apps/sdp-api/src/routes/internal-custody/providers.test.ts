import {
  CUSTODY_CONNECTION_LIFECYCLES,
  CUSTODY_PROVIDERS,
  type CustodyConfigStatus,
  type CustodyConnectionLifecycle,
  type CustodyProvider,
} from "@sdp/types/custody";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedCustodyAdmin } from "@/test/helpers/custody-admin";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  seedUnreadPrivyWallet,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { internalCustody } from "./index";

const ORGANIZATION_ID = "org_custody_setup_status";
const PROJECT_ID = "prj_custody_setup_status";
const USER_ID = "usr_custody_setup_status";
const CREDENTIAL_ID = "pcred_setup_status_privy";
const OTHER_ORGANIZATION_ID = "org_setup_status_other";
const OTHER_ORGANIZATION_PROJECT_ID = "prj_setup_status_other_sandbox";
const OWN_SCOPE = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };

// Strict below the envelope: a key the route adds, such as a connection id, fails the parse.
const setupStatusSchema = z.object({
  data: z.strictObject({
    providers: z.array(
      z.strictObject({
        provider: z.enum(CUSTODY_PROVIDERS),
        hasLegacyConfig: z.boolean(),
        effectiveTargetType: z.string(),
        connectionCounts: z.record(z.string(), z.number()),
      })
    ),
  }),
});

let token: string;
const app = new Hono<{ Bindings: Env }>();
app.use("*", kvStoreMiddleware());
app.route("/internal/dashboard/custody", internalCustody);
app.onError((error) => {
  if (error instanceof AppError)
    return Response.json(error.toResponse(), { status: error.statusCode });
  throw error;
});

async function seedConfig(
  provider: CustodyProvider,
  status: CustodyConfigStatus,
  scope: { organizationId: string; projectId: string }
): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: `cust_cfg_setup_status_${scope.projectId}_${provider}_${status}`,
        ...scope,
        provider,
        configEncrypted: "test-config",
        status,
      },
    ],
    wallets: [],
  });
}

async function seedCredential(): Promise<void> {
  await insertTestStoredProviderCredential(getDb(env), {
    id: CREDENTIAL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "Privy credential",
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "encrypted-test-payload" },
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
  });
}

async function seedUnfinishedConnection(
  id: string,
  status: Extract<CustodyConnectionLifecycle, "pending" | "failed">
): Promise<void> {
  await insertTestCustodyConnection(getDb(env), {
    id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    credential: { id: CREDENTIAL_ID, projectId: PROJECT_ID },
    status,
    setupMetadata: {},
    providerAccountFingerprint: null,
    lastCheckStatus: status === "failed" ? "failed" : null,
    lastCheckAt: status === "failed" ? "2026-08-05T00:00:00.000Z" : null,
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: USER_ID,
    createdAt: "2026-08-05T00:00:00.000Z",
  });
}

async function seedActiveConnection(projectId: string, key: string): Promise<void> {
  await getDb(env).transaction((tx) =>
    seedUnreadPrivyWallet(tx, {
      organizationId: ORGANIZATION_ID,
      projectId,
      createdBy: USER_ID,
      custodyWalletId: `cwlt_setup_status_${key}`,
      walletId: `privy_setup_status_${key}`,
      publicKey: syntheticAddress(1),
    })
  );
}

async function seedOtherOrganization(): Promise<void> {
  await getDb(env)
    .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
    .bind(OTHER_ORGANIZATION_ID, "Other", "setup-status-other", "enterprise", "active")
    .run();
  await seedDefaultProjects(getDb(env), {
    organizationId: OTHER_ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: {
      sandbox: OTHER_ORGANIZATION_PROJECT_ID,
      production: "prj_setup_status_other_production",
    },
  });
}

async function fetchSetupStatus() {
  const response = await app.request(
    "/internal/dashboard/custody/providers",
    { headers: { Authorization: `Bearer ${token}`, "X-Project-ID": PROJECT_ID } },
    env
  );
  expect(response.status).toBe(200);
  return setupStatusSchema.parse(await response.json()).data;
}

async function privyStatus() {
  const status = (await fetchSetupStatus()).providers.find((entry) => entry.provider === "privy");
  if (!status) throw new Error("Setup status is missing privy");
  return status;
}

function connectionCounts(counts: Partial<Record<CustodyConnectionLifecycle, number>>) {
  return {
    ...Object.fromEntries(CUSTODY_CONNECTION_LIFECYCLES.map((lifecycle) => [lifecycle, 0])),
    ...counts,
  };
}

describe("internal custody providers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    token = await seedCustodyAdmin(env, {
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      tier: "enterprise",
    });
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("reports every custody provider, uninstalled, when the project has no rows", async () => {
    const status = await fetchSetupStatus();

    expect(status.providers).toEqual(
      CUSTODY_PROVIDERS.map((provider) => ({
        provider,
        hasLegacyConfig: false,
        effectiveTargetType: "none",
        connectionCounts: connectionCounts({}),
      }))
    );
  });

  it("reports each provider with an active config as a config-backed target", async () => {
    await seedConfig("privy", "active", OWN_SCOPE);
    await seedConfig("para", "active", OWN_SCOPE);

    const status = await fetchSetupStatus();
    for (const provider of ["privy", "para"]) {
      expect(status.providers.find((entry) => entry.provider === provider)).toEqual({
        provider,
        hasLegacyConfig: true,
        effectiveTargetType: "config",
        connectionCounts: connectionCounts({}),
      });
    }
  });

  it("ignores an inactive config", async () => {
    await seedConfig("privy", "inactive", OWN_SCOPE);

    expect(await privyStatus()).toEqual({
      provider: "privy",
      hasLegacyConfig: false,
      effectiveTargetType: "none",
      connectionCounts: connectionCounts({}),
    });
  });

  it("counts connections by lifecycle without listing them", async () => {
    await seedCredential();
    await seedUnfinishedConnection("ccon_setup_status_pending", "pending");
    await seedUnfinishedConnection("ccon_setup_status_failed", "failed");

    // A pending connection is not yet a signing target.
    expect(await privyStatus()).toEqual({
      provider: "privy",
      hasLegacyConfig: false,
      effectiveTargetType: "none",
      connectionCounts: connectionCounts({ pending: 1, failed: 1 }),
    });
  });

  it("keeps reporting the config while signing still resolves through it", async () => {
    await seedConfig("privy", "active", OWN_SCOPE);
    await seedActiveConnection(PROJECT_ID, "both");

    // Signing never resolves through a connection today, so calling one the
    // effective target would report a migration that has not happened.
    expect(await privyStatus()).toEqual({
      provider: "privy",
      hasLegacyConfig: true,
      effectiveTargetType: "config",
      connectionCounts: connectionCounts({ active: 1 }),
    });
  });

  it("does not call a connection the signing target while nothing signs through it", async () => {
    await seedActiveConnection(PROJECT_ID, "only");

    expect(await privyStatus()).toEqual({
      provider: "privy",
      hasLegacyConfig: false,
      effectiveTargetType: "none",
      connectionCounts: connectionCounts({ active: 1 }),
    });
  });

  it("reports nothing from another project or another organization", async () => {
    await seedOtherOrganization();
    await seedConfig("privy", "active", {
      organizationId: OTHER_ORGANIZATION_ID,
      projectId: OTHER_ORGANIZATION_PROJECT_ID,
    });
    await seedActiveConnection(`${PROJECT_ID}_production`, "other_project");

    expect(await privyStatus()).toEqual({
      provider: "privy",
      hasLegacyConfig: false,
      effectiveTargetType: "none",
      connectionCounts: connectionCounts({}),
    });
  });

  it("creates nothing while reading", async () => {
    const countRows = async () =>
      getDb(env).queryOne<{ configs: number; credentials: number; connections: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM custody_configs WHERE organization_id = ?) AS configs,
           (SELECT COUNT(*)::int FROM provider_credentials WHERE organization_id = ?) AS credentials,
           (SELECT COUNT(*)::int FROM custody_connections WHERE organization_id = ?) AS connections`,
        [ORGANIZATION_ID, ORGANIZATION_ID, ORGANIZATION_ID]
      );

    await fetchSetupStatus();
    await fetchSetupStatus();

    expect(await countRows()).toEqual({ configs: 0, credentials: 0, connections: 0 });
  });
});
