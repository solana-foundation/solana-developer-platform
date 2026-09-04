import type { Token } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import * as solanaServices from "@/services/solana";
import { env as testEnv } from "@/test/helpers/env";
import { createTokenTransaction } from "@/test/helpers/factories";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  createLegacyResolvedAuthoritySigner,
  createResolvedAuthoritySigner,
  getInitialPermanentDelegateAuthority,
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolveCurrentAuthorityForRole,
  resolveDirectIssuanceReplay,
  resolveFreezeOperationAuthority,
  resolveIssuanceWallet,
  resolveMetadataAuthority,
  resolvePermanentDelegateAuthority,
} from "./authority-resolution";

const { fetchMaybeMintMock, getTokenAclMintConfigMock } = vi.hoisted(() => ({
  fetchMaybeMintMock: vi.fn(),
  getTokenAclMintConfigMock: vi.fn(),
}));

vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchMaybeMint: fetchMaybeMintMock,
}));

vi.mock("@solana/token-acl-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/token-acl-sdk")>()),
  getTokenAclMintConfig: getTokenAclMintConfigMock,
}));

const AUTHORITY = "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9";
const OTHER_AUTHORITY = "73ScTjQ3uVNHGF36yoaseFCVUYEoLhZwxvJ9z7CVseod";

function createAuth(overrides: Partial<ApiKeyContext> = {}): ApiKeyContext {
  return {
    id: "user_test",
    organizationId: "org_test",
    projectId: "proj_test",
    role: "admin",
    permissions: [],
    environment: "dashboard",
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    authType: "session",
    userId: "user_test",
    apiKeyId: null,
    ...overrides,
  } as ApiKeyContext;
}

async function seedScope(): Promise<void> {
  await getDb(testEnv).batch([
    getDb(testEnv).prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES ('org_test', 'Authority resolution', 'authority-resolution', 'individual', 'active')`
    ),
    getDb(testEnv).prepare(
      `INSERT INTO users (id, email, email_verified, status)
         VALUES ('user_test', 'authority-resolution@example.com', 1, 'active')`
    ),
    getDb(testEnv).prepare(
      `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES (
           'proj_test', 'org_test', 'Authority resolution',
           'authority-resolution', 'sandbox', 'active', 'user_test'
         )`
    ),
  ]);
}

async function resetScope(): Promise<void> {
  await seedTestDatabase(testEnv);
  await seedScope();
}

async function seedConfigWallet(input: {
  id: string;
  walletId: string;
  publicKey?: string;
  status?: "active" | "inactive";
  organizationId?: string;
  projectId?: string;
}): Promise<void> {
  const organizationId = input.organizationId ?? "org_test";
  const projectId = input.projectId ?? "proj_test";
  await getDb(testEnv).batch([
    getDb(testEnv)
      .prepare(
        `INSERT INTO custody_configs (
           id, organization_id, project_id, provider, config_encrypted,
           encryption_version, default_wallet_id, status
         ) VALUES (?, ?, ?, 'local', 'encrypted', 'test', ?, 'active')`
      )
      .bind(`cfg_${input.id}`, organizationId, projectId, input.walletId),
    getDb(testEnv)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_config_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        `cfg_${input.id}`,
        input.walletId,
        input.publicKey ?? AUTHORITY,
        input.status ?? "active"
      ),
  ]);
}

async function seedSelectedApiKey(walletId: string): Promise<ApiKeyContext> {
  await getDb(testEnv).batch([
    getDb(testEnv)
      .prepare(
        `INSERT INTO api_keys (
           id, organization_id, project_id, created_by, name,
           key_prefix, key_hash, role, permissions, status, signing_wallet_id
         ) VALUES (
           'key_test', 'org_test', 'proj_test', 'user_test', 'Test key',
           'sdp_test', 'hash_test', 'api_admin', '["tokens:write"]', 'active', ?
         )`
      )
      .bind(walletId),
    getDb(testEnv)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('permission_test', 'key_test', ?, '["tokens:write"]')`
      )
      .bind(walletId),
  ]);

  return {
    ...createAuth(),
    id: "key_test",
    authType: "api_key",
    apiKeyId: "key_test",
    userId: null,
    walletScope: "selected",
    signingWalletId: walletId,
    signingWalletIds: [walletId],
    walletBindings: [
      {
        walletId,
        custodyWalletId: "cwlt_authority",
        permissions: ["tokens:write"],
      },
    ],
  };
}

async function seedConnectionWallet(input: {
  id: string;
  walletId: string;
  publicKey?: string;
  status?: "active" | "inactive";
}): Promise<void> {
  const credentialId = `credential_${input.id}`;
  const connectionId = `connection_${input.id}`;
  await getDb(testEnv).batch([
    getDb(testEnv)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, credential_version, created_by
         ) VALUES (
           ?, 'org_test', 'proj_test', 'privy', 'Test', 'project', 'stored',
           'encrypted_db', 'encrypted', 'active', 1, 'user_test'
         )`
      )
      .bind(credentialId),
    getDb(testEnv)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (
           ?, 'org_test', 'proj_test', 'privy', 'project', ?, 'proj_test',
           'pending', 'user_test'
         )`
      )
      .bind(connectionId, credentialId),
    getDb(testEnv)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        connectionId,
        input.walletId,
        input.publicKey ?? AUTHORITY,
        input.status ?? "active"
      ),
    getDb(testEnv)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active',
             last_check_status = 'success', last_check_at = sdp_iso_now(),
             activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(input.id, connectionId),
  ]);
}

function createToken(overrides: Partial<Token> = {}): Token {
  return {
    id: "tok_test",
    projectId: "proj_test",
    organizationId: "org_test",
    signingCustodyWalletId: null,
    signingWalletId: "wal_default",
    mintAddress: "GnaWvQYgS4xypWoqA3xPgHMFxr2iGnWhEEjF6HEdutBa",
    mintAuthority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
    metadataAuthority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
    freezeAuthority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
    ablListAddress: null,
    name: "Test",
    symbol: "TEST",
    decimals: 6,
    description: null,
    uri: null,
    imageUrl: null,
    template: "stablecoin",
    extensions: { defaultAccountState: "initialized" },
    totalSupply: "0",
    totalSupplyUpdatedAt: new Date().toISOString(),
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    status: "active",
    deployedAt: new Date().toISOString(),
    createdBy: "user_test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createDecodedMint(input: {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  extensions?: unknown[];
}) {
  const option = (value: string | null | undefined) =>
    value == null ? { __option: "None" } : { __option: "Some", value };

  return {
    exists: true,
    data: {
      mintAuthority: option(input.mintAuthority),
      freezeAuthority: option(input.freezeAuthority),
      extensions: { __option: "Some", value: input.extensions ?? [] },
    },
  };
}

describe("authority-resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTokenAclMintConfigMock.mockResolvedValue({ exists: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads decoded mint authority through the configured RPC client", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("raw fetch should not be used")));
    fetchMaybeMintMock.mockResolvedValue(
      createDecodedMint({ mintAuthority: OTHER_AUTHORITY, freezeAuthority: AUTHORITY })
    );

    await expect(
      resolveCurrentAuthorityForRole(
        {
          SOLANA_RPC_URL: "https://rpc.example.test",
          SOLANA_NETWORK: "devnet",
        } as never,
        { updateTokenAuthorities: vi.fn() } as never,
        createToken(),
        "mint"
      )
    ).resolves.toBe(OTHER_AUTHORITY);
    expect(fetchMaybeMintMock).toHaveBeenCalledOnce();
  });

  it("uses the Token ACL controller for freeze operations", async () => {
    getTokenAclMintConfigMock.mockResolvedValue({
      exists: true,
      data: { freezeAuthority: AUTHORITY },
    });

    await expect(
      resolveFreezeOperationAuthority(
        {
          SOLANA_RPC_URL: "https://rpc.example.test",
          SOLANA_NETWORK: "devnet",
        } as never,
        createToken()
      )
    ).resolves.toBe(AUTHORITY);
    expect(getTokenAclMintConfigMock).toHaveBeenCalledOnce();
    expect(fetchMaybeMintMock).not.toHaveBeenCalled();
  });

  it("keeps the base freeze authority for non-Token ACL mints", async () => {
    fetchMaybeMintMock.mockResolvedValue(createDecodedMint({ freezeAuthority: AUTHORITY }));

    await expect(
      resolveFreezeOperationAuthority(
        {
          SOLANA_RPC_URL: "https://rpc.example.test",
          SOLANA_NETWORK: "devnet",
        } as never,
        createToken()
      )
    ).resolves.toBe(AUTHORITY);
    expect(fetchMaybeMintMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the Token ACL controller cannot be read", async () => {
    getTokenAclMintConfigMock.mockRejectedValue(new Error("RPC returned invalid mint config"));

    await expect(
      resolveFreezeOperationAuthority(
        {
          SOLANA_RPC_URL: "https://rpc.example.test",
          SOLANA_NETWORK: "devnet",
        } as never,
        createToken()
      )
    ).rejects.toMatchObject({ code: "SOLANA_RPC_ERROR", statusCode: 502 });
    expect(fetchMaybeMintMock).not.toHaveBeenCalled();
  });

  it("reads the on-chain permanent delegate without mutating the token record", async () => {
    fetchMaybeMintMock.mockResolvedValue(
      createDecodedMint({
        extensions: [{ __kind: "PermanentDelegate", delegate: AUTHORITY }],
      })
    );

    const tokenService = {
      updateTokenAuthorities: vi.fn(),
    } as unknown as {
      updateTokenAuthorities: ReturnType<typeof vi.fn>;
    };

    const delegate = await resolvePermanentDelegateAuthority(
      {
        SOLANA_RPC_URL: "https://rpc.example.test",
        SOLANA_NETWORK: "devnet",
      } as never,
      tokenService as never,
      createToken()
    );

    expect(delegate).toBe("AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9");
    expect(fetchMaybeMintMock).toHaveBeenCalledOnce();
    expect(tokenService.updateTokenAuthorities).not.toHaveBeenCalled();
  });

  it("falls back to the metadata pointer authority without mutating the token record", async () => {
    fetchMaybeMintMock.mockResolvedValue(
      createDecodedMint({
        extensions: [
          {
            __kind: "MetadataPointer",
            authority: { __option: "Some", value: AUTHORITY },
          },
          {
            __kind: "TokenMetadata",
            updateAuthority: { __option: "None" },
          },
        ],
      })
    );

    const tokenService = {
      updateTokenAuthorities: vi.fn(),
    } as unknown as {
      updateTokenAuthorities: ReturnType<typeof vi.fn>;
    };

    const authority = await resolveMetadataAuthority(
      {
        SOLANA_RPC_URL: "https://rpc.example.test",
        SOLANA_NETWORK: "devnet",
      } as never,
      tokenService as never,
      createToken({
        metadataAuthority: "73ScTjQ3uVNHGF36yoaseFCVUYEoLhZwxvJ9z7CVseod",
        mintAuthority: "73ScTjQ3uVNHGF36yoaseFCVUYEoLhZwxvJ9z7CVseod",
      })
    );

    expect(authority).toBe("AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9");
    expect(fetchMaybeMintMock).toHaveBeenCalledOnce();
    expect(tokenService.updateTokenAuthorities).not.toHaveBeenCalled();
  });

  it("uses live mint authority and treats a request value as an assertion", async () => {
    fetchMaybeMintMock.mockResolvedValue(
      createDecodedMint({ mintAuthority: OTHER_AUTHORITY, freezeAuthority: AUTHORITY })
    );
    const tokenService = { updateTokenAuthorities: vi.fn() };
    const env = {
      SOLANA_RPC_URL: "https://rpc.example.test",
      SOLANA_NETWORK: "devnet",
    } as never;
    const token = createToken({ mintAuthority: AUTHORITY });

    await expect(
      resolveCurrentAuthorityForRole(env, tokenService as never, token, "mint", AUTHORITY)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(tokenService.updateTokenAuthorities).not.toHaveBeenCalled();
  });

  it("maps RPC decoding failures to the public RPC error", async () => {
    fetchMaybeMintMock.mockRejectedValue(new Error("RPC returned invalid mint data"));

    await expect(
      resolveCurrentAuthorityForRole(
        {
          SOLANA_RPC_URL: "https://rpc.example.test",
          SOLANA_NETWORK: "devnet",
        } as never,
        { updateTokenAuthorities: vi.fn() } as never,
        createToken(),
        "mint"
      )
    ).rejects.toMatchObject({ code: "SOLANA_RPC_ERROR", statusCode: 502 });
  });

  it("returns no authority when the mint account is not available yet", async () => {
    fetchMaybeMintMock.mockResolvedValue({ exists: false });

    await expect(
      resolveCurrentAuthorityForRole(
        {
          SOLANA_RPC_URL: "https://rpc.example.test",
          SOLANA_NETWORK: "devnet",
        } as never,
        { updateTokenAuthorities: vi.fn() } as never,
        createToken(),
        "mint"
      )
    ).resolves.toBeNull();
  });

  it("resolves a unique authority to its exact custody wallet row", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_authority", walletId: "wal_authority" });

    await expect(
      resolveAuthorityWallet({
        env: testEnv,
        auth: createAuth(),
        currentAuthority: AUTHORITY,
        requiredWalletPermissions: ["tokens:write"],
      })
    ).resolves.toEqual({
      custodyWalletId: "cwlt_authority",
      providerWalletId: "wal_authority",
      publicKey: AUTHORITY,
    });
  });

  it("fails closed when Config and Connection rows share the authority", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_config", walletId: "wal_config" });
    await seedConnectionWallet({ id: "cwlt_connection", walletId: "wal_connection" });

    await expect(
      resolveAuthorityWallet({
        env: testEnv,
        auth: createAuth(),
        currentAuthority: AUTHORITY,
        requiredWalletPermissions: ["tokens:write"],
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("fails closed when no wallet controls the current authority", async () => {
    await resetScope();

    await expect(
      resolveAuthorityWallet({
        env: testEnv,
        auth: createAuth(),
        currentAuthority: AUTHORITY,
        requiredWalletPermissions: ["tokens:write"],
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("uses an explicit exact wallet to disambiguate matching authority rows", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_config", walletId: "wal_config" });
    await seedConnectionWallet({ id: "cwlt_connection", walletId: "wal_connection" });

    await expect(
      resolveAuthorityWallet({
        env: testEnv,
        auth: createAuth(),
        currentAuthority: AUTHORITY,
        requestedCustodyWalletId: "cwlt_connection",
        requiredWalletPermissions: ["tokens:write"],
      })
    ).resolves.toEqual({
      custodyWalletId: "cwlt_connection",
      providerWalletId: "wal_connection",
      publicKey: AUTHORITY,
    });
  });

  it("rejects an explicit exact wallet that does not control the authority", async () => {
    await resetScope();
    await seedConfigWallet({
      id: "cwlt_other",
      walletId: "wal_other",
      publicKey: OTHER_AUTHORITY,
    });

    await expect(
      resolveAuthorityWallet({
        env: testEnv,
        auth: createAuth(),
        currentAuthority: AUTHORITY,
        requestedCustodyWalletId: "cwlt_other",
        requiredWalletPermissions: ["tokens:admin"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });
  });

  it("keeps inactive rows resolvable so exact runtime admission owns the denial", async () => {
    await resetScope();
    await seedConfigWallet({
      id: "cwlt_inactive",
      walletId: "wal_inactive",
      status: "inactive",
    });
    const exactSigner = vi
      .spyOn(solanaServices, "createOrgSignerForCustodyWallet")
      .mockRejectedValueOnce(
        Object.assign(new Error("Custody wallet is unavailable"), {
          code: "CONFLICT",
          statusCode: 409,
        })
      );

    await expect(
      resolveAuthoritySigner({
        env: testEnv,
        auth: createAuth(),
        currentAuthority: AUTHORITY,
        requiredWalletPermissions: ["tokens:write"],
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(exactSigner).toHaveBeenCalledWith(testEnv, "org_test", "proj_test", "cwlt_inactive");
  });

  it("resolves an exact draft wallet without performing runtime admission", async () => {
    await resetScope();
    await seedConnectionWallet({
      id: "cwlt_draft",
      walletId: "wal_draft",
      status: "inactive",
    });
    const exactSigner = vi.spyOn(solanaServices, "createOrgSignerForCustodyWallet");

    await expect(
      resolveIssuanceWallet({
        env: testEnv,
        auth: createAuth(),
        custodyWalletId: "cwlt_draft",
        requiredWalletPermissions: ["tokens:write"],
      })
    ).resolves.toEqual({
      custodyWalletId: "cwlt_draft",
      providerWalletId: "wal_draft",
      publicKey: AUTHORITY,
    });
    expect(exactSigner).not.toHaveBeenCalled();
  });

  it("does not resolve an exact wallet from another tenant", async () => {
    await resetScope();
    await getDb(testEnv).batch([
      getDb(testEnv).prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES ('org_other', 'Other', 'authority-resolution-other', 'individual', 'active')`
      ),
      getDb(testEnv).prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES ('user_other', 'authority-resolution-other@example.com', 1, 'active')`
      ),
      getDb(testEnv).prepare(
        `INSERT INTO projects (
           id, organization_id, name, slug, environment, status, created_by
         ) VALUES (
           'proj_other', 'org_other', 'Other', 'authority-resolution-other',
           'sandbox', 'active', 'user_other'
         )`
      ),
    ]);
    await seedConfigWallet({
      id: "cwlt_other_tenant",
      walletId: "wal_other_tenant",
      organizationId: "org_other",
      projectId: "proj_other",
    });

    await expect(
      resolveIssuanceWallet({
        env: testEnv,
        auth: createAuth(),
        custodyWalletId: "cwlt_other_tenant",
        requiredWalletPermissions: ["tokens:write"],
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("revalidates selected API-key permissions for the exact wallet", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_authority", walletId: "wal_authority" });
    const auth = await seedSelectedApiKey("wal_authority");

    await expect(
      resolveIssuanceWallet({
        env: testEnv,
        auth,
        custodyWalletId: "cwlt_authority",
        requiredWalletPermissions: ["tokens:write"],
      })
    ).resolves.toMatchObject({ custodyWalletId: "cwlt_authority" });
    await expect(
      resolveIssuanceWallet({
        env: testEnv,
        auth,
        custodyWalletId: "cwlt_authority",
        requiredWalletPermissions: ["tokens:admin"],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("revalidates selected API-key access for a persisted direct-action replay", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_authority", walletId: "wal_authority" });
    const auth = await seedSelectedApiKey("wal_authority");
    const transaction = createTokenTransaction({
      tokenId: "tok_replay",
      organizationId: "org_test",
      custodyWalletId: "cwlt_authority",
      type: "burn",
      idempotencyKey: "replay",
      idempotencyFingerprint: "fingerprint",
    });
    const tokenService = {
      findTransactionByIdempotency: vi.fn().mockResolvedValue(transaction),
    };
    const replay = () =>
      resolveDirectIssuanceReplay({
        env: testEnv,
        auth,
        tokenService: tokenService as never,
        tokenId: "tok_replay",
        type: "burn",
        idempotencyKey: "replay",
        requestedCustodyWalletId: "cwlt_authority",
        requiredWalletPermissions: ["tokens:write"],
        fingerprintForCustodyWalletId: () => "fingerprint",
      });

    await expect(replay()).resolves.toBe(transaction);
    await getDb(testEnv).batch([
      getDb(testEnv).prepare(
        "DELETE FROM api_key_wallet_permissions WHERE api_key_id = 'key_test'"
      ),
      getDb(testEnv).prepare("UPDATE api_keys SET signing_wallet_id = NULL WHERE id = 'key_test'"),
    ]);
    await expect(replay()).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("rejects a requested replay wallet that differs from the persisted pin", async () => {
    await resetScope();
    const fingerprint = vi.fn(() => "fingerprint");
    const transaction = createTokenTransaction({
      tokenId: "tok_replay",
      organizationId: "org_test",
      custodyWalletId: "cwlt_persisted",
      type: "burn",
      idempotencyKey: "replay",
      idempotencyFingerprint: "fingerprint",
    });

    await expect(
      resolveDirectIssuanceReplay({
        env: testEnv,
        auth: createAuth(),
        tokenService: {
          findTransactionByIdempotency: vi.fn().mockResolvedValue(transaction),
        } as never,
        tokenId: "tok_replay",
        type: "burn",
        idempotencyKey: "replay",
        requestedCustodyWalletId: "cwlt_other",
        requiredWalletPermissions: ["tokens:write"],
        fingerprintForCustodyWalletId: fingerprint,
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("rejects a mismatched persisted pin before loading its signer", async () => {
    await resetScope();
    await seedConfigWallet({
      id: "cwlt_other",
      walletId: "wal_other",
      publicKey: OTHER_AUTHORITY,
    });
    const exactSigner = vi
      .spyOn(solanaServices, "createOrgSignerForCustodyWallet")
      .mockResolvedValueOnce({ address: OTHER_AUTHORITY } as never);

    await expect(
      createResolvedAuthoritySigner({
        env: testEnv,
        auth: createAuth(),
        custodyWalletId: "cwlt_other",
        currentAuthority: AUTHORITY,
        requiredWalletPermissions: ["tokens:admin"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });
    expect(exactSigner).not.toHaveBeenCalled();
  });

  it("reports a signer that diverges from its wallet record as a conflict", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_authority", walletId: "wal_authority" });
    vi.spyOn(solanaServices, "createOrgSignerForCustodyWallet").mockResolvedValueOnce({
      address: OTHER_AUTHORITY,
    } as never);

    await expect(
      createResolvedAuthoritySigner({
        env: testEnv,
        auth: createAuth(),
        custodyWalletId: "cwlt_authority",
        currentAuthority: AUTHORITY,
        requiredWalletPermissions: ["tokens:admin"],
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("keeps legacy prepare signers Config-only", async () => {
    await resetScope();
    await seedConnectionWallet({ id: "cwlt_connection", walletId: "wal_connection" });
    const exactSigner = vi.spyOn(solanaServices, "createOrgSignerForCustodyWallet");

    await expect(
      createLegacyResolvedAuthoritySigner({
        env: testEnv,
        auth: createAuth(),
        walletId: "wal_connection",
        expectedCustodyWalletId: "cwlt_connection",
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(exactSigner).not.toHaveBeenCalled();
  });

  it("rejects a divergent legacy provider mirror before loading secrets", async () => {
    await resetScope();
    await seedConfigWallet({ id: "cwlt_pinned", walletId: "wal_pinned" });
    const exactSigner = vi.spyOn(solanaServices, "createOrgSignerForCustodyWallet");

    await expect(
      createLegacyResolvedAuthoritySigner({
        env: testEnv,
        auth: createAuth(),
        walletId: "wal_other",
        expectedCustodyWalletId: "cwlt_pinned",
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(exactSigner).not.toHaveBeenCalled();
  });

  it("persists the initial permanent delegate for template tokens on deploy", () => {
    expect(
      getInitialPermanentDelegateAuthority(
        createToken(),
        "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9"
      )
    ).toBe("AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9");
  });
});
