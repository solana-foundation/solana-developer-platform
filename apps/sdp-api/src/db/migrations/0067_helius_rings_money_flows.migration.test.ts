import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

// The test database is already fully migrated by src/test/node-global-setup.ts,
// so these assertions are behavioural: every test inserts real rows against the
// real schema inside a transaction and rolls back.

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0067_helius_rings_money_flows.sql"
  ),
  "utf8"
);

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
 * The pairing invariant: an identity without its owner cannot be verified, and
 * an owner without an identity has nothing to verify.
 */
describe("owner and identity travel together", () => {
  it("refuses an identity written without its owner", async () => {
    const { walletId } = await seedWallet("pair_check");

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

describe("custody_wallet_id", () => {
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

describe("re-applying the migration", () => {
  it("is a no-op", async () => {
    // This file was iterated on before it shipped, and the runner keys
    // `schema_migrations` on the file name — so a database carrying an earlier
    // draft will run it again. Every constraint and index it creates is dropped
    // first for that reason; a bare `ADD CONSTRAINT` would abort here on a
    // duplicate name and leave the migration half-applied.
    await expect(client.query(migrationSql)).resolves.toBeDefined();

    // Still enforcing afterwards, rather than merely not throwing.
    const seed = await seedWallet("reapply");
    await expectSqlstate(
      () =>
        client.query("UPDATE helius_rings_wallets SET shielded_address = 'rings1x' WHERE id = $1", [
          seed.walletId,
        ]),
      CHECK_VIOLATION
    );
  });
});

describe("voided state", () => {
  /** Signed bytes and their expiry travel together; the outbox CHECKs say so. */
  const SIGNED = {
    outer_tx_signature: "sig_reconcile",
    signed_transaction: "AQAB",
    last_valid_block_height: "100",
  };

  const FAILURE = {
    failure_code: "manual_reconciliation_required",
    failure_message: "expired without being indexed",
    retryable: false,
  };

  it("accepts a voided row carrying the failure that put it in front of an operator", async () => {
    const seed = await seedWallet("void_ok");

    await insertOperation({
      id: "hro_void_ok",
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      intent_key: "sha256:void_ok",
      op_type: "withdraw",
      state: "voided",
      ...SIGNED,
      ...FAILURE,
    });

    const { rows } = await client.query<{ state: string; failure_code: string }>(
      "SELECT state, failure_code FROM helius_rings_operations WHERE id = 'hro_void_ok'"
    );
    // The triple survives: it is why the row was reconciled at all, and
    // clearing it would erase that.
    expect(rows[0]).toMatchObject({ state: "voided", failure_code: FAILURE.failure_code });
  });

  it("refuses a voided row with no failure recorded", async () => {
    const seed = await seedWallet("void_bare");

    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_void_bare",
          organization_id: seed.organizationId,
          project_id: seed.projectId,
          wallet_id: seed.walletId,
          intent_key: "sha256:void_bare",
          op_type: "withdraw",
          state: "voided",
          ...SIGNED,
        }),
      CHECK_VIOLATION
    );
  });

  it("still refuses a completed row that carries a failure", async () => {
    const seed = await seedWallet("done_failed");

    // This is what forces the reconcile's landed path to null all three in the
    // same UPDATE as the state change.
    await expectSqlstate(
      () =>
        insertOperation({
          id: "hro_done_failed",
          organization_id: seed.organizationId,
          project_id: seed.projectId,
          wallet_id: seed.walletId,
          intent_key: "sha256:done_failed",
          op_type: "withdraw",
          state: "completed",
          ...SIGNED,
          ...FAILURE,
        }),
      CHECK_VIOLATION
    );
  });

  const HOLDS = [
    ["failed", true],
    ["voided", false],
    ["completed", false],
  ] as const;

  it.each(HOLDS)("a %s spend with bytes: slot held = %s", async (state, holds) => {
    const seed = await seedWallet(`slot_${state}`);
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "withdraw",
    };

    await insertOperation({
      ...common,
      id: `hro_slot_${state}`,
      intent_key: `sha256:slot_${state}`,
      state,
      ...SIGNED,
      ...(state === "completed" ? {} : FAILURE),
    });

    const fileAnother = () =>
      insertOperation({
        ...common,
        id: `hro_slot_${state}_next`,
        intent_key: `sha256:slot_${state}_next`,
        state: "proving",
      });

    // The entire mechanism: `voided` is not a state either index names, so a
    // reconciled row releases the wallet without the predicates knowing it
    // exists.
    if (holds) {
      await expectSqlstate(fileAnother, UNIQUE_VIOLATION);
    } else {
      await expect(fileAnother()).resolves.toBeUndefined();
    }
  });

  it("releases a deposit's slot the same way", async () => {
    const seed = await seedWallet("slot_shield");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "shield",
    };

    await insertOperation({
      ...common,
      id: "hro_slot_shield",
      intent_key: "sha256:slot_shield",
      state: "voided",
      ...SIGNED,
      ...FAILURE,
    });

    await expect(
      insertOperation({
        ...common,
        id: "hro_slot_shield_next",
        intent_key: "sha256:slot_shield_next",
        state: "proving",
      })
    ).resolves.toBeUndefined();
  });
});

describe("last_indexed_slot", () => {
  it("records how far the indexer must catch up before a read is trusted", async () => {
    const { walletId } = await seedWallet("slot_ok");

    // A slot near the top of the uint64 range: this is NUMERIC precisely so a
    // real slot cannot be rounded by a driver that routes it through a double.
    await client.query("UPDATE helius_rings_wallets SET last_indexed_slot = $1 WHERE id = $2", [
      "18446744073709551000",
      walletId,
    ]);

    const { rows } = await client.query<{ last_indexed_slot: string }>(
      "SELECT last_indexed_slot FROM helius_rings_wallets WHERE id = $1",
      [walletId]
    );
    expect(String(rows[0]?.last_indexed_slot)).toBe("18446744073709551000");
  });

  it("starts null, because a wallet that has never been read has no position", async () => {
    const { walletId } = await seedWallet("slot_null");

    const { rows } = await client.query<{ last_indexed_slot: string | null }>(
      "SELECT last_indexed_slot FROM helius_rings_wallets WHERE id = $1",
      [walletId]
    );
    expect(rows[0]?.last_indexed_slot).toBeNull();
  });

  it.each([
    ["a fraction", "10.5"],
    ["beyond a uint64", "18446744073709551616"],
    ["negative", "-1"],
  ])("refuses a slot that is %s", async (label, value) => {
    const { walletId } = await seedWallet(`slot_bad_${label.replace(/\W/g, "")}`);

    await expectSqlstate(
      () =>
        client.query("UPDATE helius_rings_wallets SET last_indexed_slot = $1 WHERE id = $2", [
          value,
          walletId,
        ]),
      CHECK_VIOLATION
    );
  });
});

describe("input_notes", () => {
  async function operationWithNotes(tag: string, notes: string[] | null): Promise<string> {
    const seed = await seedWallet(tag);
    const id = `hro_${tag}`;
    await insertOperation({
      id,
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      intent_key: `sha256:${tag}`,
      op_type: "withdraw",
      state: "proving",
    });

    if (notes !== null) {
      await client.query(
        "UPDATE helius_rings_operations SET input_notes = $1::jsonb WHERE id = $2",
        [JSON.stringify(notes), id]
      );
    }
    return id;
  }

  it("records the commitments a build committed to spending", async () => {
    const notes = ["aa11", "bb22"];
    const id = await operationWithNotes("notes_ok", notes);

    const { rows } = await client.query<{ input_notes: string[] }>(
      "SELECT input_notes FROM helius_rings_operations WHERE id = $1",
      [id]
    );
    // Read back whole and in order: a rebuild pins these positionally.
    expect(rows[0]?.input_notes).toEqual(notes);
  });

  it("distinguishes a shield's empty set from a build that has not run", async () => {
    const unbuilt = await operationWithNotes("notes_null", null);
    const shielded = await operationWithNotes("notes_empty", []);

    const { rows } = await client.query<{ id: string; input_notes: string[] | null }>(
      "SELECT id, input_notes FROM helius_rings_operations WHERE id = ANY($1) ORDER BY id",
      [[unbuilt, shielded]]
    );

    // Not the same fact: null means nothing was built, [] means a flow that
    // consumes no notes was.
    expect(rows.find((row) => row.id === unbuilt)?.input_notes).toBeNull();
    expect(rows.find((row) => row.id === shielded)?.input_notes).toEqual([]);
  });

  it.each([
    ["an object", '{"a":1}'],
    ["a bare string", '"aa11"'],
    ["a number", "42"],
  ])("refuses %s rather than an array", async (label, value) => {
    const id = await operationWithNotes(`notes_bad_${label.replace(/\W/g, "")}`, null);

    // A serialization bug here would only surface as a failed rebuild, long
    // after the write that caused it.
    await expectSqlstate(
      () =>
        client.query("UPDATE helius_rings_operations SET input_notes = $1::jsonb WHERE id = $2", [
          value,
          id,
        ]),
      CHECK_VIOLATION
    );
  });
});

describe("manual_reconciliation_required", () => {
  it("accepts the code for a spend that can neither be retried nor closed", async () => {
    const seed = await seedWallet("mrr_ok");

    await insertOperation({
      id: "hro_mrr_ok",
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      intent_key: "sha256:mrr_ok",
      op_type: "withdraw",
      state: "failed",
      failure_code: "manual_reconciliation_required",
      failure_message: "expired without being indexed",
      retryable: false,
    });

    const { rows } = await client.query<{ failure_code: string; retryable: boolean }>(
      "SELECT failure_code, retryable FROM helius_rings_operations WHERE id = 'hro_mrr_ok'"
    );
    expect(rows[0]).toMatchObject({
      failure_code: "manual_reconciliation_required",
      // The whole point of the code: never offer a retry that could pay twice.
      retryable: false,
    });
  });
});

describe("reconciliation lookup", () => {
  it("finds a submitted operation whose signed bytes can no longer land", async () => {
    const seed = await seedWallet("sweep");

    await insertOperation({
      id: "hro_sweep",
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      intent_key: "sha256:sweep",
      op_type: "withdraw",
      state: "submitted",
      outer_tx_signature: "sig_sweep",
      signed_transaction: "AQAB",
      last_valid_block_height: "100",
    });

    // The query the sweep runs. uint64 heights are compared as NUMERIC, never
    // through a JS number, so a height above 2^53 still orders correctly.
    const expiredAt = async (height: string) =>
      (
        await client.query<{ id: string }>(
          `SELECT id FROM helius_rings_operations
            WHERE signed_transaction IS NOT NULL
              AND last_valid_block_height < $1
              AND state IN ('submitted', 'indexing')`,
          [height]
        )
      ).rows.map((row) => row.id);

    expect(await expiredAt("18446744073709551000")).toContain("hro_sweep");
    // Still live at height 50, so the sweep must leave it alone.
    expect(await expiredAt("50")).not.toContain("hro_sweep");
  });
});

describe("config_error", () => {
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

describe("one active private spend per wallet", () => {
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

  it("keeps the slot held by a failed spend that was already signed", async () => {
    const seed = await seedWallet("spend_failed_signed");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "withdraw",
    };

    // Failed, but with bytes that may be in the mempool or already settled.
    await insertOperation({
      ...common,
      id: "hro_fs_first",
      intent_key: "sha256:fs_first",
      state: "failed",
      failure_code: "indexing_timeout",
      failure_message: "photon never caught up",
      retryable: true,
      outer_tx_signature: "sig_fs",
      signed_transaction: "AQAB",
      last_valid_block_height: "100",
    });

    // Filing another under a fresh nonce is how a second payment gets made:
    // the retry endpoint refuses, so this is the door a caller reaches for.
    await expectSqlstate(
      () =>
        insertOperation({
          ...common,
          id: "hro_fs_second",
          intent_key: "sha256:fs_second",
          state: "proving",
        }),
      UNIQUE_VIOLATION
    );
  });

  it("frees the slot for a spend that failed before it was signed", async () => {
    const seed = await seedWallet("spend_failed_unsigned");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "withdraw",
    };

    await insertOperation({
      ...common,
      id: "hro_fu_first",
      intent_key: "sha256:fu_first",
      state: "failed",
      failure_code: "policy_denied",
      failure_message: "denied by wallet policy",
      retryable: false,
    });

    // Nothing was ever sent, so nothing can duplicate. Holding the slot here
    // would freeze a wallet over a rejected request.
    await insertOperation({
      ...common,
      id: "hro_fu_second",
      intent_key: "sha256:fu_second",
      state: "proving",
    });

    const { rows } = await client.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM helius_rings_operations WHERE wallet_id = $1",
      [seed.walletId]
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it("refuses a second deposit while an earlier one has unsettled bytes", async () => {
    const seed = await seedWallet("shield_unsettled");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "shield",
    };

    await insertOperation({
      ...common,
      id: "hro_su_first",
      intent_key: "sha256:su_first",
      state: "failed",
      failure_code: "manual_reconciliation_required",
      failure_message: "expired without being indexed",
      retryable: false,
      outer_tx_signature: "sig_su",
      signed_transaction: "AQAB",
      last_valid_block_height: "100",
    });

    // A deposit cannot double-spend a note, but it can execute twice, which
    // debits the owner's public balance for an amount they never asked to move.
    // The new row is in flight rather than failed, which is exactly why the
    // predicate has to cover both: two rows only collide if both match it.
    await expectSqlstate(
      () =>
        insertOperation({
          ...common,
          id: "hro_su_second",
          intent_key: "sha256:su_second",
          state: "proving",
        }),
      UNIQUE_VIOLATION
    );
  });

  it("serialises deposits, at the cost of two at once", async () => {
    const seed = await seedWallet("spend_shield");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      op_type: "shield",
      state: "proving",
    };

    await insertOperation({ ...common, id: "hro_shield_a", intent_key: "sha256:shield_a" });

    // Deliberate: two simultaneous deposits are a convenience, and allowing
    // them would mean a duplicate never collides with the row it duplicates,
    // leaving the service check as the only defence.
    await expectSqlstate(
      () => insertOperation({ ...common, id: "hro_shield_b", intent_key: "sha256:shield_b" }),
      UNIQUE_VIOLATION
    );
  });

  it("does not let a deposit block a spend, or the reverse", async () => {
    const seed = await seedWallet("shield_vs_spend");
    const common = {
      organization_id: seed.organizationId,
      project_id: seed.projectId,
      wallet_id: seed.walletId,
      state: "proving",
    };

    // Separate indexes rather than one: a deposit landing late only adds notes,
    // so it has no bearing on what a withdrawal may spend.
    await insertOperation({
      ...common,
      id: "hro_mix_shield",
      intent_key: "sha256:mix_shield",
      op_type: "shield",
    });
    await insertOperation({
      ...common,
      id: "hro_mix_withdraw",
      intent_key: "sha256:mix_withdraw",
      op_type: "withdraw",
    });

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

describe("submission outbox", () => {
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
