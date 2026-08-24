import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so these assertions are behavioural: every test inserts real rows against the
// real schema inside a transaction and rolls back.

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

let client: Client;

async function expectSqlstate(work: () => Promise<unknown>, sqlstate: string): Promise<void> {
  await client.query("SAVEPOINT probe");
  await expect(work()).rejects.toMatchObject({ code: sqlstate });
  await client.query("ROLLBACK TO SAVEPOINT probe");
}

async function seedWallet(tag: string): Promise<{
  organizationId: string;
  projectId: string;
  walletId: string;
  custodyWalletId: string;
}> {
  const organizationId = `org_${tag}`;
  const projectId = `proj_${tag}`;
  const userId = `user_${tag}`;
  const walletId = `hrw_${tag}`;
  const custodyConfigId = `cc_${tag}`;
  const custodyWalletId = `cw_${tag}`;

  await client.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)", [
    organizationId,
  ]);
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    userId,
    `${tag}@example.test`,
  ]);
  await client.query(
    "INSERT INTO projects (id, organization_id, name, slug, created_by) VALUES ($1, $2, $1, $1, $3)",
    [projectId, organizationId, userId]
  );
  await client.query(
    `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted)
     VALUES ($1, $2, $3, 'turnkey', '{}')`,
    [custodyConfigId, organizationId, projectId]
  );
  await client.query(
    `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key)
     VALUES ($1, $2, $3, $4)`,
    [custodyWalletId, custodyConfigId, `tw_${tag}`, `pk_${tag}`]
  );
  await client.query(
    `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name)
     VALUES ($1, $2, $3, $4, 'Treasury')`,
    [walletId, organizationId, projectId, `sdpw_${tag}`]
  );

  return { organizationId, projectId, walletId, custodyWalletId };
}

async function insertOperation(
  overrides: Record<string, string | boolean | null> & {
    id: string;
    organization_id: string;
    project_id: string;
    wallet_id: string;
    intent_key: string;
  }
): Promise<void> {
  const row: Record<string, string | boolean | null> = { op_type: "shield", ...overrides };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(
    `INSERT INTO helius_rings_operations (${columns.join(", ")}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

/**
 * The upgrade path, not the finished schema.
 *
 * Every other test here runs against a database this migration has already
 * been applied to, where `helius_rings_wallets` was empty at the time. That
 * says nothing about an environment that provisioned wallets under 0057 —
 * which is the only environment the migration actually has to survive.
 */
describe("0067 against rows that predate it", () => {
  /** Recreates what 0057 left behind: an identity with no owner beside it. */
  async function makeLegacyRow(tag: string): Promise<void> {
    const { walletId } = await seedWallet(tag);
    await client.query(
      "ALTER TABLE helius_rings_wallets DROP CONSTRAINT helius_rings_wallets_owner_identity_pair_check"
    );
    await client.query(
      "UPDATE helius_rings_wallets SET shielded_address = 'rings1legacy', owner_address = NULL WHERE id = $1",
      [walletId]
    );
  }

  it("would fail to apply if the pairing constraint validated existing rows", async () => {
    await makeLegacyRow("legacy_strict");

    // Why the shipped constraint carries NOT VALID. A plain ADD CONSTRAINT
    // checks every existing row, and each simulated wallet already on disk
    // violates it — so the migration would abort on exactly the deployments
    // that have been running longest.
    await expectSqlstate(
      () =>
        client.query(
          `ALTER TABLE helius_rings_wallets
               ADD CONSTRAINT helius_rings_wallets_owner_identity_pair_check
                   CHECK ((owner_address IS NULL) = (shielded_address IS NULL))`
        ),
      CHECK_VIOLATION
    );
  });

  it("applies to a wallet provisioned before owner_address existed", async () => {
    await makeLegacyRow("legacy");

    await expect(
      client.query(
        `ALTER TABLE helius_rings_wallets
             ADD CONSTRAINT helius_rings_wallets_owner_identity_pair_check
                 CHECK ((owner_address IS NULL) = (shielded_address IS NULL)) NOT VALID`
      )
    ).resolves.toBeDefined();
  });

  it("still refuses a new identity written without its owner", async () => {
    const { walletId } = await seedWallet("legacy_new");

    // NOT VALID grandfathers existing rows; it does not stop governing writes.
    await expectSqlstate(
      () =>
        client.query(
          "UPDATE helius_rings_wallets SET shielded_address = 'rings1new' WHERE id = $1",
          [walletId]
        ),
      CHECK_VIOLATION
    );
  });
});

describe("0067 custody_wallet_id", () => {
  it("links a Rings wallet to the custody row that signs for it", async () => {
    const { walletId, custodyWalletId } = await seedWallet("cw_ok");

    await client.query("UPDATE helius_rings_wallets SET custody_wallet_id = $1 WHERE id = $2", [
      custodyWalletId,
      walletId,
    ]);

    const { rows } = await client.query<{ custody_wallet_id: string }>(
      "SELECT custody_wallet_id FROM helius_rings_wallets WHERE id = $1",
      [walletId]
    );
    expect(rows[0]?.custody_wallet_id).toBe(custodyWalletId);
  });

  it("stays null for the simulated wallets provisioned before this migration", async () => {
    const { walletId } = await seedWallet("cw_null");

    const { rows } = await client.query<{ custody_wallet_id: string | null }>(
      "SELECT custody_wallet_id FROM helius_rings_wallets WHERE id = $1",
      [walletId]
    );
    expect(rows[0]?.custody_wallet_id).toBeNull();
  });

  it("refuses a custody wallet that does not exist", async () => {
    const { walletId } = await seedWallet("cw_fk");

    await expectSqlstate(
      () =>
        client.query("UPDATE helius_rings_wallets SET custody_wallet_id = $1 WHERE id = $2", [
          "cw_missing",
          walletId,
        ]),
      FK_VIOLATION
    );
  });

  it("refuses to delete a custody wallet a Rings identity still signs through", async () => {
    const { walletId, custodyWalletId } = await seedWallet("cw_restrict");
    await client.query("UPDATE helius_rings_wallets SET custody_wallet_id = $1 WHERE id = $2", [
      custodyWalletId,
      walletId,
    ]);

    // Cascading would silently orphan a live shielded identity from the only
    // key that can spend it.
    await expectSqlstate(
      () => client.query("DELETE FROM custody_wallets WHERE id = $1", [custodyWalletId]),
      FK_VIOLATION
    );
  });
});

describe("0067 config_error", () => {
  it("accepts config_error as a failure code", async () => {
    const seed = await seedWallet("fc_ok");

    await insertOperation({
      id: "hro_fc_ok",
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      intent_key: "sha256:fc_ok",
      state: "failed",
      failure_code: "config_error",
      failure_message: "HELIUS_RINGS_PROVER_URL is not set",
      retryable: false,
    });

    const { rows } = await client.query<{ failure_code: string }>(
      "SELECT failure_code FROM helius_rings_operations WHERE id = 'hro_fc_ok'"
    );
    expect(rows[0]?.failure_code).toBe("config_error");
  });

  it("still rejects a code outside the vocabulary", async () => {
    const seed = await seedWallet("fc_bad");

    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_fc_bad",
          organization_id: seed.organizationId,
          project_id: seed.projectId,
          wallet_id: seed.walletId,
          intent_key: "sha256:fc_bad",
          state: "failed",
          failure_code: "misconfigured",
          failure_message: "typo",
          retryable: false,
        }),
      CHECK_VIOLATION
    );
  });
});

describe("0067 one active private spend per wallet", () => {
  const SPENDS = ["transfer_registered", "withdraw", "merge"] as const;

  it.each(SPENDS)("refuses a second in-flight %s for the same wallet", async (opType) => {
    const seed = await seedWallet(`spend_${opType}`);
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: opType,
      state: "proving",
      ...(opType === "transfer_registered" ? { transfer_mode: "registered" } : {}),
    };

    await insertOperation({ ...common, id: `hro_${opType}_a`, intent_key: `sha256:${opType}_a` });

    await expectSqlstate(
      () =>
        insertOperation({
          ...common,
          id: `hro_${opType}_b`,
          intent_key: `sha256:${opType}_b`,
        }),
      UNIQUE_VIOLATION
    );
  });

  it("treats different spend types as the same slot", async () => {
    const seed = await seedWallet("spend_mixed");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      state: "proving",
    };

    await insertOperation({
      ...common,
      id: "hro_mixed_w",
      intent_key: "sha256:mixed_w",
      op_type: "withdraw",
    });

    // They all consume notes from the same set, so a withdrawal and a merge
    // racing is exactly the overlap the index exists to prevent.
    await expectSqlstate(
      () =>
        insertOperation({
          ...common,
          id: "hro_mixed_m",
          intent_key: "sha256:mixed_m",
          op_type: "merge",
        }),
      UNIQUE_VIOLATION
    );
  });

  it("frees the slot once the operation reaches a terminal state", async () => {
    const seed = await seedWallet("spend_free");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "withdraw",
    };

    await insertOperation({
      ...common,
      id: "hro_free_a",
      intent_key: "sha256:free_a",
      state: "completed",
    });
    await insertOperation({
      ...common,
      id: "hro_free_b",
      intent_key: "sha256:free_b",
      state: "failed",
      failure_code: "submit_failed",
      failure_message: "dropped",
      retryable: true,
    });

    await insertOperation({
      ...common,
      id: "hro_free_c",
      intent_key: "sha256:free_c",
      state: "proving",
    });

    const { rows } = await client.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM helius_rings_operations WHERE wallet_id = $1",
      [seed.walletId]
    );
    expect(Number(rows[0]?.count)).toBe(3);
  });

  it.each(["draft", "preparing", "approval_required"])(
    "leaves the slot free while a spend is still only %s",
    async (state) => {
      const seed = await seedWallet(`spend_early_${state}`);
      const common = {
        organization_id: seed.organizationId,
        project_id: seed.projectId,
        wallet_id: seed.walletId,
        op_type: "withdraw",
        state,
      };

      // Nothing has selected notes yet, so there is nothing to collide. A
      // wallet whose owner is waiting on an approver must still be able to
      // prepare other work.
      await insertOperation({ ...common, id: `hro_early_${state}_a`, intent_key: `s:${state}_a` });
      await insertOperation({ ...common, id: `hro_early_${state}_b`, intent_key: `s:${state}_b` });

      const { rows } = await client.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM helius_rings_operations WHERE wallet_id = $1",
        [seed.walletId]
      );
      expect(Number(rows[0]?.count)).toBe(2);
    }
  );

  it("takes the slot as soon as notes are selected, even behind an earlier draft", async () => {
    const seed = await seedWallet("spend_draft_then");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "withdraw",
    };

    await insertOperation({
      ...common,
      id: "hro_dt_draft",
      intent_key: "sha256:dt_draft",
      state: "draft",
    });
    await insertOperation({
      ...common,
      id: "hro_dt_proving",
      intent_key: "sha256:dt_proving",
      state: "proving",
    });

    await expectSqlstate(
      () =>
        insertOperation({
          ...common,
          id: "hro_dt_second",
          intent_key: "sha256:dt_second",
          state: "proving",
        }),
      UNIQUE_VIOLATION
    );
  });

  it("does not serialise shields, which create notes rather than consume them", async () => {
    const seed = await seedWallet("spend_shield");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "shield",
      state: "proving",
    };

    await insertOperation({ ...common, id: "hro_shield_a", intent_key: "sha256:shield_a" });
    await insertOperation({ ...common, id: "hro_shield_b", intent_key: "sha256:shield_b" });

    const { rows } = await client.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM helius_rings_operations WHERE wallet_id = $1",
      [seed.walletId]
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it("scopes the slot to one wallet", async () => {
    const a = await seedWallet("spend_wa");
    const b = await seedWallet("spend_wb");

    for (const seed of [a, b]) {
      await insertOperation({
        id: `hro_${seed.walletId}`,
        organization_id: seed.organizationId,
        project_id: seed.projectId,
        wallet_id: seed.walletId,
        intent_key: `sha256:${seed.walletId}`,
        op_type: "withdraw",
        state: "proving",
      });
    }

    const { rows } = await client.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM helius_rings_operations WHERE wallet_id = ANY($1)",
      [[a.walletId, b.walletId]]
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });
});

describe("0067 submission outbox", () => {
  async function base(tag: string) {
    const seed = await seedWallet(tag);
    return {
      id: `hro_${tag}`,
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      intent_key: `sha256:${tag}`,
    };
  }

  it("records signed bytes, expiry and the locally derived signature together", async () => {
    await insertOperation({
      ...(await base("outbox_ok")),
      outer_tx_signature: "sig_ok",
      signed_transaction: "AQAB",
      last_valid_block_height: "123456",
      submission_started_at: "2026-08-24T00:00:00.000Z",
    });

    const { rows } = await client.query<{ signed_transaction: string }>(
      "SELECT signed_transaction FROM helius_rings_operations WHERE id = 'hro_outbox_ok'"
    );
    expect(rows[0]?.signed_transaction).toBe("AQAB");
  });

  it("refuses signed bytes with no expiry to retire them by", async () => {
    const row = await base("outbox_noexp");
    await expectSqlstate(
      () => insertOperation({ ...row, outer_tx_signature: "sig", signed_transaction: "AQAB" }),
      CHECK_VIOLATION
    );
  });

  it("refuses an expiry with no bytes to act on", async () => {
    const row = await base("outbox_nobytes");
    await expectSqlstate(
      () => insertOperation({ ...row, last_valid_block_height: "123456" }),
      CHECK_VIOLATION
    );
  });

  it("refuses signed bytes without the signature a recovery reconciles against", async () => {
    const row = await base("outbox_nosig");
    await expectSqlstate(
      () =>
        insertOperation({
          ...row,
          signed_transaction: "AQAB",
          last_valid_block_height: "123456",
        }),
      CHECK_VIOLATION
    );
  });

  it("refuses a submission marked started before anything was signed", async () => {
    const row = await base("outbox_started");
    await expectSqlstate(
      () => insertOperation({ ...row, submission_started_at: "2026-08-24T00:00:00.000Z" }),
      CHECK_VIOLATION
    );
  });

  it("refuses a fractional or out-of-range block height", async () => {
    const fractional = await base("outbox_frac");
    await expectSqlstate(
      () =>
        insertOperation({
          ...fractional,
          outer_tx_signature: "sig",
          signed_transaction: "AQAB",
          last_valid_block_height: "1.5",
        }),
      CHECK_VIOLATION
    );

    const negative = await base("outbox_neg");
    await expectSqlstate(
      () =>
        insertOperation({
          ...negative,
          outer_tx_signature: "sig",
          signed_transaction: "AQAB",
          last_valid_block_height: "-1",
        }),
      CHECK_VIOLATION
    );
  });
});
