import {
  CUSTODY_CONFIG_STATUSES,
  type CustodyConfigStatus,
  isUnarchivedCustodyConfigStatus,
} from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createSigningService } from "@/services/domain/signing.service";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ORGANIZATION_ID = "org_custody_config_store";
const PROJECT_ID = "prj_custody_config_store";
const OTHER_PROJECT_ID = "prj_custody_config_store_other";
const USER_ID = "usr_custody_config_store";
const CONFIG_ID = "cust_custody_config_store";
const CUSTODY_WALLET_ID = "cwlt_custody_config_store";
const PROVIDER_WALLET_ID = "privy_custody_config_store";
const PUBLIC_KEY = "Vote111111111111111111111111111111111111111";

describe("CustodyConfigStore project scope", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedScope();
  });

  it.each(CUSTODY_CONFIG_STATUSES)(
    "finds a %s config by provider only while it is unarchived",
    async (status) => {
      await seedPrivyConfig({ projectId: PROJECT_ID, status });
      const store = new CustodyConfigStore(getDb(env), env);

      await expect(store.findByProvider(ORGANIZATION_ID, PROJECT_ID, "privy")).resolves.toEqual(
        isUnarchivedCustodyConfigStatus(status) ? expectedConfigRecord(PROJECT_ID, status) : null
      );
    }
  );

  it("never returns another project's active config", async () => {
    await seedPrivyConfig({ projectId: OTHER_PROJECT_ID, status: "active" });
    const rowsBefore = await readCustodyRows();
    const store = new CustodyConfigStore(getDb(env), env);

    await expect(
      store.findActiveByProvider(ORGANIZATION_ID, OTHER_PROJECT_ID, "privy")
    ).resolves.toEqual(expectedConfigRecord(OTHER_PROJECT_ID, "active"));
    await expect(
      store.findActiveByProvider(ORGANIZATION_ID, PROJECT_ID, "privy")
    ).resolves.toBeNull();
    await expect(store.listActive(ORGANIZATION_ID, PROJECT_ID)).resolves.toEqual([]);
    expect(await readCustodyRows()).toEqual(rowsBefore);
  });

  it("never resolves a wallet under another project's config", async () => {
    await seedPrivyConfig({ projectId: PROJECT_ID, status: "active" });
    const rowsBefore = await readCustodyRows();
    const store = new CustodyConfigStore(getDb(env), env);
    const signingService = createSigningService(env);

    await expect(
      store.findActiveWalletByIdentifier(ORGANIZATION_ID, PROJECT_ID, PROVIDER_WALLET_ID)
    ).resolves.toEqual(expectedWalletLookup());
    await expect(
      store.findActiveWalletByPublicKey(ORGANIZATION_ID, PROJECT_ID, PUBLIC_KEY)
    ).resolves.toEqual(expectedWalletLookup());
    await expect(
      signingService.getPublicKey(ORGANIZATION_ID, OTHER_PROJECT_ID, PROVIDER_WALLET_ID)
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
    await expect(
      signingService.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        OTHER_PROJECT_ID,
        CUSTODY_WALLET_ID
      )
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
    await expect(
      store.findUniqueActiveWalletByIdentifier(
        ORGANIZATION_ID,
        OTHER_PROJECT_ID,
        PROVIDER_WALLET_ID
      )
    ).resolves.toBeNull();
    await expect(
      store.findActiveWalletByPublicKey(ORGANIZATION_ID, OTHER_PROJECT_ID, PUBLIC_KEY)
    ).resolves.toBeNull();
    expect(await readCustodyRows()).toEqual(rowsBefore);
  });

  it("refuses to delete a wallet under another project's config", async () => {
    await seedPrivyConfig({ projectId: PROJECT_ID, status: "active" });
    const rowsBefore = await readCustodyRows();

    await expect(
      createSigningService(env).deleteWallet(ORGANIZATION_ID, OTHER_PROJECT_ID, {
        walletId: PROVIDER_WALLET_ID,
        configId: CONFIG_ID,
      })
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
    expect(await readCustodyRows()).toEqual(rowsBefore);
  });
});

async function seedScope(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Custody config store', 'custody-config-store', 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID),
    db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'custody-config-store@example.com', 1, 'active')`
      )
      .bind(USER_ID),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
  });
}

async function seedPrivyConfig(params: {
  projectId: string;
  status: CustodyConfigStatus;
}): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: params.projectId,
        provider: "privy",
        configEncrypted: "encrypted",
        status: params.status,
      },
    ],
    wallets: [
      {
        id: CUSTODY_WALLET_ID,
        owner: { kind: "config", custodyConfigId: CONFIG_ID },
        walletId: PROVIDER_WALLET_ID,
        publicKey: PUBLIC_KEY,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
}

function expectedConfigRecord(projectId: string, status: CustodyConfigStatus) {
  return {
    id: CONFIG_ID,
    organizationId: ORGANIZATION_ID,
    projectId,
    provider: "privy",
    config: "encrypted",
    encryptionVersion: "sdp-custody-encryption-v1",
    status,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  };
}

function expectedWalletLookup() {
  return {
    id: CUSTODY_WALLET_ID,
    custodyConfigId: CONFIG_ID,
    walletId: PROVIDER_WALLET_ID,
    publicKey: PUBLIC_KEY,
    label: null,
    purpose: null,
    status: "active",
    createdAt: expect.any(String),
    provider: "privy",
    projectId: PROJECT_ID,
  };
}

async function readCustodyRows() {
  const db = getDb(env);
  return {
    configs: await db.queryMany("SELECT * FROM custody_configs ORDER BY id"),
    wallets: await db.queryMany("SELECT * FROM custody_wallets ORDER BY id"),
  };
}
