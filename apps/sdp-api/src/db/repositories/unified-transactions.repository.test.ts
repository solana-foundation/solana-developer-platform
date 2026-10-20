import {
  PAYMENT_TRANSACTION_KINDS,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { encodeKeysetCursor } from "@/lib/keyset-cursor";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresUnifiedTransactionsRepository } from "./unified-transactions.repository.postgres";

const PROJECT = "prj_unified_transactions";
const WALLET = "wallet_unified_transactions";
const CUSTODY_WALLET = "cwlt_unified_transactions";
const OTHER_CUSTODY_WALLET = "cwlt_unified_transactions_other";
const CREATED_AT = "2026-09-15T10:00:00.000Z";

async function seedTransfer(input: {
  id: string;
  type: string;
  status: string;
  custodyWalletId: string | null;
  counterpartyId: string | null;
}): Promise<void> {
  if (input.counterpartyId !== null) {
    await getDb(env).execute(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
       VALUES (?, ?, ?, 'individual', ?)
       ON CONFLICT (id) DO NOTHING`,
      [input.counterpartyId, TEST_ORG.id, PROJECT, input.counterpartyId]
    );
  }
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
         (id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
          destination_address, token, amount, type, direction, status, counterparty_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'source', 'destination', ?, '10', ?, 'outbound', ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      TEST_ORG.id,
      PROJECT,
      WALLET,
      input.custodyWalletId,
      wellKnownMint("USDC", "devnet"),
      input.type,
      input.status,
      input.counterpartyId,
      CREATED_AT,
      CREATED_AT
    )
    .run();
}

describe("UnifiedTransactionsRepository (postgres)", () => {
  afterEach(() => seedTestDatabase(env));

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_unified_transactions",
          organizationId: TEST_ORG.id,
          projectId: PROJECT,
          provider: "local",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: CUSTODY_WALLET,
          owner: { kind: "config", custodyConfigId: "cfg_unified_transactions" },
          walletId: WALLET,
          publicKey: "UnifiedWallet111",
          label: null,
          purpose: null,
          status: "active",
        },
        {
          id: OTHER_CUSTODY_WALLET,
          owner: { kind: "config", custodyConfigId: "cfg_unified_transactions" },
          walletId: "wallet-other",
          publicKey: "UnifiedWallet222",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });
  });

  it("filters by module, kind, and status class", async () => {
    await seedTransfer({
      id: "xfr_unified_match",
      type: "transfer_batch",
      status: "confirmed",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: null,
    });
    await seedTransfer({
      id: "xfr_unified_other",
      type: "transfer",
      status: "processing",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: null,
    });
    const result = await createPostgresUnifiedTransactionsRepository(getDb(env)).list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments"],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      module: "payments",
      kind: "batch_pay",
      status: "succeeded",
      limit: 25,
    });
    expect(result.rows.map((row) => row.id)).toEqual(["xfr_unified_match"]);
  });

  it("matches search as a prefix of the identifier, never a substring", async () => {
    await seedTransfer({
      id: "xfr_unified_searchable",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: null,
    });
    const repository = createPostgresUnifiedTransactionsRepository(getDb(env));
    const base = {
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments"] as UnifiedTransactionModule[],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      limit: 25,
    };

    const byPrefix = await repository.list({ ...base, search: "xfr_unified_sea" });
    expect(byPrefix.rows.map((row) => row.id)).toEqual(["xfr_unified_searchable"]);

    // A leading wildcard would force a sequential scan of every module's
    // money table behind the view, so substring search is deliberately not
    // offered.
    const bySubstring = await repository.list({ ...base, search: "unified_searchable" });
    expect(bySubstring.rows).toEqual([]);
  });

  it("filters by counterparty ID", async () => {
    await seedTransfer({
      id: "xfr_unified_counterparty_match",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: "cpty_match",
    });
    await seedTransfer({
      id: "xfr_unified_counterparty_other",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: "cpty_other",
    });

    const result = await createPostgresUnifiedTransactionsRepository(getDb(env)).list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments"],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      counterpartyId: "cpty_match",
      limit: 25,
    });

    expect(result.rows.map((row) => row.id)).toEqual(["xfr_unified_counterparty_match"]);
  });

  it("restricts rows to the permitted module allowlist", async () => {
    await seedTransfer({
      id: "xfr_unified_permitted",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: null,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO issued_tokens
           (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by)
         VALUES ('tok_unified_permissions', ?, ?, 'UnifiedPermissionsMint', 'Unified', 'UNI', 6, ?)`
      )
      .bind(PROJECT, TEST_ORG.id, TEST_USER.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO issuance_transactions
           (id, token_id, organization_id, type, status, operation_params)
         VALUES ('itx_unified_denied', 'tok_unified_permissions', ?, 'mint', 'confirmed', '{}')`
      )
      .bind(TEST_ORG.id)
      .run();

    const result = await createPostgresUnifiedTransactionsRepository(getDb(env)).list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments"],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      limit: 25,
    });

    expect(result.rows.map((row) => row.id)).toEqual(["xfr_unified_permitted"]);
  });

  it("round-trips a keyset cursor across equal timestamps", async () => {
    await seedTransfer({
      id: "xfr_unified_a",
      type: "transfer",
      status: "processing",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: null,
    });
    await getDb(env)
      .prepare(
        `INSERT INTO issued_tokens
           (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by,
            created_at, updated_at)
         VALUES ('tok_unified', ?, ?, 'UnifiedMint111', 'Unified', 'UNI', 6, ?, ?, ?)`
      )
      .bind(PROJECT, TEST_ORG.id, TEST_USER.id, CREATED_AT, CREATED_AT)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO issuance_transactions
           (id, token_id, organization_id, type, status, operation_params, created_at, updated_at)
         VALUES ('itx_unified_b', 'tok_unified', ?, 'mint', 'processing', '{}', ?, ?)`
      )
      .bind(TEST_ORG.id, CREATED_AT, CREATED_AT)
      .run();
    const repository = createPostgresUnifiedTransactionsRepository(getDb(env));
    const first = await repository.list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments", "issuance"],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      limit: 1,
    });
    if (first.nextCursor === null) throw new Error("first page did not produce a cursor");
    const second = await repository.list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments", "issuance"],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      cursor: first.nextCursor,
      limit: 1,
    });
    expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual([
      "xfr_unified_a",
      "itx_unified_b",
    ]);
  });

  it("projects the custody wallet label for labeled, unlabeled, and walletless rows", async () => {
    await getDb(env)
      .prepare("UPDATE custody_wallets SET label = ? WHERE id = ?")
      .bind("Treasury", CUSTODY_WALLET)
      .run();
    await seedTransfer({
      id: "xfr_unified_lbl_labeled",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: CUSTODY_WALLET,
      counterpartyId: null,
    });
    await seedTransfer({
      id: "xfr_unified_lbl_unlabeled",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: OTHER_CUSTODY_WALLET,
      counterpartyId: null,
    });
    await seedTransfer({
      id: "xfr_unified_lbl_walletless",
      type: "transfer",
      status: "confirmed",
      custodyWalletId: null,
      counterpartyId: null,
    });

    const result = await createPostgresUnifiedTransactionsRepository(getDb(env)).list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["payments"],
      excludedRampProviders: [],
      paymentKinds: PAYMENT_TRANSACTION_KINDS,
      limit: 25,
    });

    expect(
      result.rows.map((row) => ({ id: row.id, custodyWalletLabel: row.custodyWalletLabel }))
    ).toEqual([
      { id: "xfr_unified_lbl_walletless", custodyWalletLabel: null },
      { id: "xfr_unified_lbl_unlabeled", custodyWalletLabel: null },
      { id: "xfr_unified_lbl_labeled", custodyWalletLabel: "Treasury" },
    ]);
  });

  it("rejects an invalid inner cursor as a bad request", async () => {
    const repository = createPostgresUnifiedTransactionsRepository(getDb(env));
    await expect(
      repository.list({
        organizationId: TEST_ORG.id,
        projectId: PROJECT,
        modules: ["payments"],
        excludedRampProviders: [],
        paymentKinds: PAYMENT_TRANSACTION_KINDS,
        cursor: encodeKeysetCursor(JSON.stringify({ createdAt: CREATED_AT }), "missing-fields"),
        limit: 25,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
