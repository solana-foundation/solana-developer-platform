/**
 * Settled Metadata Authority Revocation Regression Tests
 *
 * SOLA9-574: a settled `role=metadata,newAuthority=null` update stores NULL in
 * `issued_tokens.metadata_authority` and removes the legacy `metadataAuthority`
 * extension, but the ordinary detail and list reads reconstructed the mint
 * authority through the mapper fallback — so a revoked metadata capability was
 * reported as owned by the mint signer.
 *
 * The fix records the explicit revocation in a durable tri-state flag
 * (`metadata_authority_revoked`), returns null for it on every ordinary read,
 * and keeps the mint fallback only for legacy rows that were never explicitly
 * set.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TokenService } from "@/services/token.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT, TEST_PROJECT_API_KEY, TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

describe("TokenService settled metadata authority revocation", () => {
  let db: ReturnType<typeof getDb>;
  let tokenService: TokenService;

  const mintAuthority = TEST_SOLANA_ADDRESSES.wallet1;
  const metadataAuthority = TEST_SOLANA_ADDRESSES.wallet2;

  const insertTokenWithAuthorities = async (tokenId: string): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO issued_tokens (
           id, project_id, organization_id, mint_address, mint_authority,
           metadata_authority, freeze_authority, name, symbol, decimals,
           total_supply_cached, is_mintable, freeze_authority_enabled,
           allowlist_enabled, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'Revocable Token', 'RVT', 6, '0', 1, 0, 0,
                   'active', ?)`
      )
      .bind(
        tokenId,
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_SOLANA_ADDRESSES.mint,
        mintAuthority,
        metadataAuthority,
        TEST_PROJECT_API_KEY.id
      )
      .run();
  };

  const insertSettledMetadataUpdate = async (
    transactionId: string,
    tokenId: string,
    newAuthority: string | null,
    slot: number,
    createdAt: string
  ): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO issuance_transactions (
           id, token_id, organization_id, type, status, operation_params,
           slot, created_at, updated_at, initiated_by_key_id
         ) VALUES (?, ?, ?, 'update_authority', 'confirmed', ?, ?, ?, ?, ?)`
      )
      .bind(
        transactionId,
        tokenId,
        TEST_ORG.id,
        JSON.stringify({ role: "metadata", newAuthority }),
        slot,
        createdAt,
        createdAt,
        TEST_PROJECT_API_KEY.id
      )
      .run();
  };

  const metadataColumn = (tokenId: string) =>
    db
      .prepare("SELECT metadata_authority FROM issued_tokens WHERE id = ?")
      .bind(tokenId)
      .first<{ metadata_authority: string | null }>();

  const revokedFlag = (tokenId: string) =>
    db
      .prepare("SELECT metadata_authority_revoked FROM issued_tokens WHERE id = ?")
      .bind(tokenId)
      .first<{ metadata_authority_revoked: number }>();

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    db = getDb(env);
    tokenService = new TokenService(db);
    await seedTestDatabase(env);

    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active')`
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
      ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
    });
    await db
      .prepare(
        `INSERT INTO api_keys (
           id, organization_id, project_id, created_by, name, key_prefix, key_hash,
           role, permissions, status
         ) VALUES (?, ?, ?, ?, 'Revocation key', 'rvt', 'rvt_hash', 'api_admin', '["*"]', 'active')`
      )
      .bind(TEST_PROJECT_API_KEY.id, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id)
      .run();
  });

  it("returns null (not the mint authority) from detail and list reads after a settled revocation", async () => {
    const tokenId = "tok_metadata_revoke_regression";
    const transactionId = "ttx_metadata_revoke_regression";
    await insertTokenWithAuthorities(tokenId);
    await db
      .prepare(
        `INSERT INTO issued_token_extensions (id, token_id, extension, config)
         VALUES (?, ?, 'metadataAuthority', ?)`
      )
      .bind("tex_metadata_revoke_regression", tokenId, JSON.stringify(metadataAuthority))
      .run();
    await insertSettledMetadataUpdate(
      transactionId,
      tokenId,
      null,
      100,
      "2026-09-01T00:00:00.000Z"
    );

    await tokenService.applySettledTokenAuthority(transactionId, tokenId, "metadata", null);

    // Canonical storage: explicit revocation, no legacy extension left behind.
    await expect(metadataColumn(tokenId)).resolves.toEqual({ metadata_authority: null });
    await expect(revokedFlag(tokenId)).resolves.toEqual({
      metadata_authority_revoked: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT id FROM issued_token_extensions WHERE token_id = ? AND extension = 'metadataAuthority'"
        )
        .bind(tokenId)
        .first()
    ).toBeNull();

    // Ordinary reads must not reconstruct the revoked capability as the mint
    // authority: the settled state is "no metadata authority".
    const detail = await tokenService.getToken({
      tokenId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    expect(detail?.metadataAuthority).toBeNull();
    expect(detail?.metadataAuthorityRevoked).toBe(true);
    expect(detail?.mintAuthority).toBe(mintAuthority);

    const list = await tokenService.listTokens(TEST_PROJECT.id, { limit: 100, offset: 0 });
    const listed = list.tokens.find((token) => token.id === tokenId);
    expect(listed?.metadataAuthority).toBeNull();
    expect(listed?.metadataAuthorityRevoked).toBe(true);
  });

  it("keeps the mint fallback for legacy rows that were never explicitly set", async () => {
    const tokenId = "tok_metadata_legacy_unset";
    await db
      .prepare(
        `INSERT INTO issued_tokens (
           id, project_id, organization_id, mint_address, mint_authority,
           metadata_authority, freeze_authority, name, symbol, decimals,
           total_supply_cached, is_mintable, freeze_authority_enabled,
           allowlist_enabled, status, created_by
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'Legacy Token', 'LGC', 6, '0', 1, 0, 0,
                   'active', ?)`
      )
      .bind(
        tokenId,
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_SOLANA_ADDRESSES.mint,
        mintAuthority,
        TEST_PROJECT_API_KEY.id
      )
      .run();

    const detail = await tokenService.getToken({
      tokenId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    expect(detail?.metadataAuthority).toBe(mintAuthority);
    expect(detail?.metadataAuthorityRevoked).toBe(false);
  });

  it("clears the revoked state when a later settled update grants a new metadata authority", async () => {
    const tokenId = "tok_metadata_regrant_after_revoke";
    const revokeId = "ttx_metadata_regrant_revoke";
    const grantId = "ttx_metadata_regrant_grant";
    await insertTokenWithAuthorities(tokenId);
    await insertSettledMetadataUpdate(revokeId, tokenId, null, 100, "2026-09-01T00:00:00.000Z");
    await insertSettledMetadataUpdate(
      grantId,
      tokenId,
      metadataAuthority,
      101,
      "2026-09-01T00:01:00.000Z"
    );

    await tokenService.applySettledTokenAuthority(revokeId, tokenId, "metadata", null);
    await tokenService.applySettledTokenAuthority(grantId, tokenId, "metadata", metadataAuthority);

    await expect(metadataColumn(tokenId)).resolves.toEqual({
      metadata_authority: metadataAuthority,
    });
    await expect(revokedFlag(tokenId)).resolves.toEqual({ metadata_authority_revoked: 0 });

    const detail = await tokenService.getToken({
      tokenId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    expect(detail?.metadataAuthority).toBe(metadataAuthority);
    expect(detail?.metadataAuthorityRevoked).toBe(false);
  });

  it("does not let an older revocation replay resurrect itself after a newer grant", async () => {
    const tokenId = "tok_metadata_replay_after_grant";
    const revokeId = "ttx_metadata_replay_revoke";
    const grantId = "ttx_metadata_replay_grant";
    await insertTokenWithAuthorities(tokenId);
    await insertSettledMetadataUpdate(revokeId, tokenId, null, 100, "2026-09-01T00:00:00.000Z");
    await insertSettledMetadataUpdate(
      grantId,
      tokenId,
      metadataAuthority,
      101,
      "2026-09-01T00:01:00.000Z"
    );

    // The newer grant settles first; the older revocation is then replayed.
    await tokenService.applySettledTokenAuthority(grantId, tokenId, "metadata", metadataAuthority);
    await tokenService.applySettledTokenAuthority(revokeId, tokenId, "metadata", null);

    // The older revocation must not overwrite the newer settled authority, and
    // the revoked marker must stay consistent with the stored authority.
    await expect(metadataColumn(tokenId)).resolves.toEqual({
      metadata_authority: metadataAuthority,
    });
    await expect(revokedFlag(tokenId)).resolves.toEqual({ metadata_authority_revoked: 0 });

    const detail = await tokenService.getToken({
      tokenId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    expect(detail?.metadataAuthority).toBe(metadataAuthority);
    expect(detail?.metadataAuthorityRevoked).toBe(false);
  });
});
