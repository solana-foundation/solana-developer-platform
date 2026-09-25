import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";
import { seedOrgProject } from "@/test/helpers/migration-db";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0119_token_metadata_authority_revocation.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
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

async function insertToken(params: {
  id: string;
  projectId: string;
  organizationId: string;
  userId: string;
  mintAddress: string;
  mintAuthority: string;
  metadataAuthority: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO issued_tokens (
       id, project_id, organization_id, mint_address, mint_authority,
       metadata_authority, name, symbol, status, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 'Revocation Token', 'RVT', 'active', $7)`,
    [
      params.id,
      params.projectId,
      params.organizationId,
      params.mintAddress,
      params.mintAuthority,
      params.metadataAuthority,
      params.userId,
    ]
  );
}

async function insertSettledMetadataUpdate(params: {
  id: string;
  tokenId: string;
  organizationId: string;
  newAuthority: string | null;
  slot: number;
  createdAt: string;
  /** NULL simulates a settled update the runtime mirror has not applied yet. */
  bookkeptAt: string | null;
}): Promise<void> {
  await client.query(
    `INSERT INTO issuance_transactions (
       id, token_id, organization_id, type, status, operation_params,
       slot, created_at, updated_at, authority_bookkeeping_applied_at
     ) VALUES ($1, $2, $3, 'update_authority', 'confirmed', $4, $5, $6, $6, $7)`,
    [
      params.id,
      params.tokenId,
      params.organizationId,
      JSON.stringify({ role: "metadata", newAuthority: params.newAuthority }),
      params.slot,
      params.createdAt,
      params.bookkeptAt,
    ]
  );
}

const revokedFlag = async (tokenId: string): Promise<number> => {
  const result = await client.query<{ metadata_authority_revoked: number }>(
    "SELECT metadata_authority_revoked FROM issued_tokens WHERE id = $1",
    [tokenId]
  );
  return result.rows[0].metadata_authority_revoked;
};

describe("0119 token metadata authority revocation backfill", () => {
  it("flags historical settled revocations the mirror already bookkept, idempotently", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_backfill");
    await insertToken({
      id: "tok_0119_historical_revoke",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_historical_revoke",
      mintAuthority: "wallet_0119_mint",
      // Pre-migration state: the settled mirror applied the revocation, which
      // only NULLed the column — ordinary reads then fell back to the mint
      // authority and reported the revoked capability as mint-owned.
      metadataAuthority: null,
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_historical_revoke",
      tokenId: "tok_0119_historical_revoke",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });

    await client.query(migrationSql);
    expect(await revokedFlag("tok_0119_historical_revoke")).toBe(1);

    // Re-running the migration must not flip the backfilled state back.
    await client.query(migrationSql);
    expect(await revokedFlag("tok_0119_historical_revoke")).toBe(1);
  });

  it("keeps the mint fallback for tokens that never stored a metadata authority", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_legacy");
    await insertToken({
      id: "tok_0119_legacy_unset",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_legacy_unset",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: null,
    });

    await client.query(migrationSql);

    expect(await revokedFlag("tok_0119_legacy_unset")).toBe(0);
  });

  it("does not flag tokens whose newest bookkept update grants an authority", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_grant");
    await insertToken({
      id: "tok_0119_granted",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_granted",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: "wallet_0119_metadata",
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_granted",
      tokenId: "tok_0119_granted",
      organizationId,
      newAuthority: "wallet_0119_metadata",
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });

    await client.query(migrationSql);

    expect(await revokedFlag("tok_0119_granted")).toBe(0);
  });

  it("does not flag a revocation that a later bookkept grant superseded", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_regrant");
    await insertToken({
      id: "tok_0119_regranted",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_regranted",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: "wallet_0119_metadata",
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_regranted_revoke",
      tokenId: "tok_0119_regranted",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_regranted_grant",
      tokenId: "tok_0119_regranted",
      organizationId,
      newAuthority: "wallet_0119_metadata",
      slot: 101,
      createdAt: "2026-08-01T00:10:00.000Z",
      bookkeptAt: "2026-08-01T00:15:00.000Z",
    });

    await client.query(migrationSql);

    expect(await revokedFlag("tok_0119_regranted")).toBe(0);
  });

  it("breaks recency ties on created_at and id exactly like the runtime mirror", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_ties");
    await insertToken({
      id: "tok_0119_tie_created_at",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_tie_created_at",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: "wallet_0119_metadata",
    });
    await insertToken({
      id: "tok_0119_tie_id",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_tie_id",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: "wallet_0119_metadata",
    });
    // Same slot: the later created_at grant wins over the revocation.
    await insertSettledMetadataUpdate({
      id: "ttx_0119_tie_created_at_revoke",
      tokenId: "tok_0119_tie_created_at",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_tie_created_at_grant",
      tokenId: "tok_0119_tie_created_at",
      organizationId,
      newAuthority: "wallet_0119_metadata",
      slot: 100,
      createdAt: "2026-08-01T00:01:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });
    // Same slot and created_at: the greater transaction id wins.
    await insertSettledMetadataUpdate({
      id: "ttx_0119_tie_id_a_revoke",
      tokenId: "tok_0119_tie_id",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_tie_id_b_grant",
      tokenId: "tok_0119_tie_id",
      organizationId,
      newAuthority: "wallet_0119_metadata",
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });

    await client.query(migrationSql);

    expect(await revokedFlag("tok_0119_tie_created_at")).toBe(0);
    expect(await revokedFlag("tok_0119_tie_id")).toBe(0);
  });

  it("fails closed for a bookkept revocation superseded only by an unbookkept grant", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_unbookkept");
    await insertToken({
      id: "tok_0119_pending_grant",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_pending_grant",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: null,
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_pending_grant_revoke",
      tokenId: "tok_0119_pending_grant",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });
    // Confirmed on-chain but not yet bookkept: the runtime mirror still owns
    // it and will clear the flag when it applies the grant.
    await insertSettledMetadataUpdate({
      id: "ttx_0119_pending_grant_grant",
      tokenId: "tok_0119_pending_grant",
      organizationId,
      newAuthority: "wallet_0119_metadata",
      slot: 101,
      createdAt: "2026-08-01T00:10:00.000Z",
      bookkeptAt: null,
    });

    await client.query(migrationSql);

    expect(await revokedFlag("tok_0119_pending_grant")).toBe(1);
  });

  it("skips a malformed operation_params row instead of aborting the migration", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_malformed");
    await insertToken({
      id: "tok_0119_malformed_revoke",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_malformed_revoke",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: null,
    });
    await client.query(
      `INSERT INTO issuance_transactions (
         id, token_id, organization_id, type, status, operation_params,
         slot, created_at, updated_at, authority_bookkeeping_applied_at
       ) VALUES ($1, $2, $3, 'update_authority', 'confirmed', $4, $5, $6, $6, $7)`,
      [
        "ttx_0119_malformed_revoke",
        "tok_0119_malformed_revoke",
        organizationId,
        // Legacy/corrupt rows: operation_params is unconstrained text and the
        // column cannot be cast to jsonb.
        "not-json{",
        100,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:05:00.000Z",
      ]
    );

    // Must not throw: a malformed row rolls nothing back.
    await client.query(migrationSql);

    // The malformed row is not a readable metadata update, so nothing decides
    // the flag for this token.
    expect(await revokedFlag("tok_0119_malformed_revoke")).toBe(0);
  });

  it("lets the newest malformed row be ignored by an older bookkept revocation", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(
      client,
      "0119_malformed_newer"
    );
    await insertToken({
      id: "tok_0119_malformed_newer",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_malformed_newer",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: null,
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_malformed_newer_revoke",
      tokenId: "tok_0119_malformed_newer",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: "2026-08-01T00:05:00.000Z",
    });
    await client.query(
      `INSERT INTO issuance_transactions (
         id, token_id, organization_id, type, status, operation_params,
         slot, created_at, updated_at, authority_bookkeeping_applied_at
       ) VALUES ($1, $2, $3, 'update_authority', 'confirmed', $4, $5, $6, $6, $7)`,
      [
        "ttx_0119_malformed_newer_opaque",
        "tok_0119_malformed_newer",
        organizationId,
        "not-json{",
        101,
        "2026-08-01T00:10:00.000Z",
        "2026-08-01T00:15:00.000Z",
      ]
    );

    await client.query(migrationSql);

    // The malformed newer row cannot be read as a metadata update, so the
    // newest readable bookkept revocation decides — matching how the runtime
    // treats an unparseable params payload.
    expect(await revokedFlag("tok_0119_malformed_newer")).toBe(1);
  });

  it("leaves settled updates the runtime mirror has not bookkept yet", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0119_unapplied");
    await insertToken({
      id: "tok_0119_unbookkept_revoke",
      projectId,
      organizationId,
      userId,
      mintAddress: "mint_0119_unbookkept_revoke",
      mintAuthority: "wallet_0119_mint",
      metadataAuthority: "wallet_0119_metadata",
    });
    await insertSettledMetadataUpdate({
      id: "ttx_0119_unbookkept_revoke",
      tokenId: "tok_0119_unbookkept_revoke",
      organizationId,
      newAuthority: null,
      slot: 100,
      createdAt: "2026-08-01T00:00:00.000Z",
      bookkeptAt: null,
    });

    await client.query(migrationSql);

    // The runtime mirror still applies this revocation and will set the flag
    // itself; the backfill must not decide over its head.
    expect(await revokedFlag("tok_0119_unbookkept_revoke")).toBe(0);
  });
});
