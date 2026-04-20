import type { Token } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyContext } from "@/lib/auth";
import * as solanaServices from "@/services/solana";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import {
  getInitialPermanentDelegateAuthority,
  resolveAuthoritySigner,
  resolveMetadataAuthority,
  resolvePermanentDelegateAuthority,
} from "./authority-resolution";

const createOrgSignerMock = vi.spyOn(solanaServices, "createOrgSigner");

function createToken(overrides: Partial<Token> = {}): Token {
  return {
    id: "tok_test",
    projectId: "proj_test",
    organizationId: "org_test",
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

describe("authority-resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backfills the on-chain permanent delegate when the token record is missing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          value: {
            data: {
              parsed: {
                info: {
                  extensions: [
                    {
                      extension: "permanentDelegate",
                      state: {
                        delegate: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenService.updateTokenAuthorities).toHaveBeenCalledWith("tok_test", {
      permanentDelegate: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
    });
  });

  it("backfills the on-chain metadata authority when the token record is stale", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          value: {
            data: {
              parsed: {
                info: {
                  extensions: [
                    {
                      extension: "metadataPointer",
                      state: {
                        authority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
                      },
                    },
                    {
                      extension: "tokenMetadata",
                      state: {
                        updateAuthority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenService.updateTokenAuthorities).toHaveBeenCalledWith("tok_test", {
      metadataAuthority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
    });
  });

  it("uses the current authority wallet when the preferred signing wallet is stale", async () => {
    const auth: ApiKeyContext = {
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
    };

    createOrgSignerMock
      .mockResolvedValueOnce({
        address: "73ScTjQ3uVNHGF36yoaseFCVUYEoLhZwxvJ9z7CVseod",
      } as never)
      .mockResolvedValueOnce({
        address: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
      } as never);

    vi.spyOn(CustodyConfigStore.prototype, "findActiveWalletByPublicKey").mockResolvedValue({
      id: "cwlt_root",
      custodyConfigId: "cust_cfg",
      walletId: "wal_root",
      publicKey: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
      label: "Root",
      purpose: "root",
      status: "active",
      createdAt: new Date().toISOString(),
      provider: "privy",
      projectId: "proj_test",
    });

    const result = await resolveAuthoritySigner({
      env: {
        HYPERDRIVE: {
          connectionString: "postgresql://sdp:sdp@127.0.0.1:5432/sdp",
        },
        CUSTODY_ENCRYPTION_KEY: "test",
      } as never,
      auth,
      token: createToken({ signingWalletId: "wal_default" }),
      requestedWalletId: "wal_default",
      currentAuthority: "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9",
    });

    expect(result.walletId).toBe("wal_root");
    expect(result.signer.address).toBe("AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9");
    expect(createOrgSignerMock).toHaveBeenCalledTimes(2);
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
