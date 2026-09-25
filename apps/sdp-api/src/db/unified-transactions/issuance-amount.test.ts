import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresUnifiedTransactionsRepository } from "../repositories/unified-transactions.repository.postgres";

/**
 * Regression for SOLA9-498: the unified issuance source projected a hard-coded
 * NULL amount, so /v1/transactions dropped the quantity of every value-moving
 * issuance event (mint, burn, seize, force_burn) even though each handler
 * persists a validated decimal in operation_params.amount. Lifecycle-only kinds
 * legitimately have no amount and must stay null, and malformed or legacy
 * operation_params must degrade to null instead of breaking the view.
 */

const PROJECT = "prj_issuance_amount";
const TOKEN_ID = "tok_issuance_amount";
const CREATED_AT = "2026-09-15T10:00:00.000Z";

describe("unified issuance amount projection", () => {
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
    await db
      .prepare(
        `INSERT INTO issued_tokens
           (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by)
         VALUES (?, ?, ?, 'IssuanceAmountMint111', 'Amount', 'AMT', 6, ?)`
      )
      .bind(TOKEN_ID, PROJECT, TEST_ORG.id, TEST_USER.id)
      .run();

    // Value-bearing kinds: handlers persist the exact decimal in
    // operation_params.amount (see mint.ts, burn.ts, seize.ts, force-burn.ts).
    const rows = [
      ["itx_amt_burn", "burn", { amount: "7" }],
      ["itx_amt_force_burn", "force_burn", { amount: "9.5" }],
      ["itx_amt_mint", "mint", { amount: "12.3456" }],
      ["itx_amt_seize", "seize", { amount: "0.125" }],
      // Lifecycle-only kinds never carry an amount.
      ["itx_lifecycle_deploy", "deploy", {}],
      ["itx_lifecycle_freeze", "freeze", { accountAddress: "acc_1" }],
      // Malformed JSON must stay nullable instead of breaking the view.
      ["itx_malformed_mint", "mint", "not-json" as unknown as Record<string, unknown>],
      // A non-numeric amount on a value-bearing kind must not project.
      ["itx_nonnumeric_burn", "burn", { amount: "not-a-number" }],
    ] as const;
    for (const [id, type, params] of rows) {
      await db
        .prepare(
          `INSERT INTO issuance_transactions
             (id, token_id, organization_id, type, status, operation_params, signature,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`
        )
        .bind(
          id,
          TOKEN_ID,
          TEST_ORG.id,
          type,
          JSON.stringify(params),
          `sig_${id}`,
          CREATED_AT,
          CREATED_AT
        )
        .run();
    }
  });

  afterEach(() => seedTestDatabase(env));

  it("projects stored amounts for value-bearing kinds and keeps lifecycle rows null", async () => {
    const result = await createPostgresUnifiedTransactionsRepository(getDb(env)).list({
      organizationId: TEST_ORG.id,
      projectId: PROJECT,
      modules: ["issuance"],
      module: "issuance",
      limit: 10,
    });
    const rows = result.rows
      .map((row) => ({ id: row.id, kind: row.kind, token: row.token, amount: row.amount }))
      .sort((a, b) => a.id.localeCompare(b.id));

    expect(rows).toEqual([
      { id: "itx_amt_burn", kind: "burn", token: "IssuanceAmountMint111", amount: "7" },
      {
        id: "itx_amt_force_burn",
        kind: "force_burn",
        token: "IssuanceAmountMint111",
        amount: "9.5",
      },
      { id: "itx_amt_mint", kind: "mint", token: "IssuanceAmountMint111", amount: "12.3456" },
      { id: "itx_amt_seize", kind: "seize", token: "IssuanceAmountMint111", amount: "0.125" },
      { id: "itx_lifecycle_deploy", kind: "deploy", token: "IssuanceAmountMint111", amount: null },
      { id: "itx_lifecycle_freeze", kind: "freeze", token: "IssuanceAmountMint111", amount: null },
      { id: "itx_malformed_mint", kind: "mint", token: "IssuanceAmountMint111", amount: null },
      {
        id: "itx_nonnumeric_burn",
        kind: "burn",
        token: "IssuanceAmountMint111",
        amount: null,
      },
    ]);
  });
});
