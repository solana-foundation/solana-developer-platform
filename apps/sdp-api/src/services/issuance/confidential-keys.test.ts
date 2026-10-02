import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";

const deriveConfidentialKeys = vi.fn();
const freeConfidentialKeys = vi.fn();
const createOrgSigner = vi.fn();

vi.mock("@solana/mosaic-sdk/confidential", () => ({
  deriveConfidentialKeys: (input: unknown) => deriveConfidentialKeys(input),
  freeConfidentialKeys: (keys: unknown) => freeConfidentialKeys(keys),
}));

vi.mock("@/services/solana", () => ({
  createOrgSigner: (...args: unknown[]) => createOrgSigner(...args),
}));

const { deriveConfidentialKeysForWallet, withConfidentialKeys } = await import(
  "./confidential-keys"
);

const OWNER = "8pM1Wt8ry9tmQoYPgMSeFsY84Sq6JTRGs9ELfJC7TnLq";
const OTHER = "6dNVE9bPzNtHGqmnCpTqFtRYBVpCsxQxvjNvrSpTPn1P";

/** A signer shaped enough for `isMessagePartialSigner` to accept it. */
const messageSigner = (address: string) => ({
  address,
  signMessages: vi.fn(),
});

const params = (overrides: Record<string, unknown> = {}) =>
  ({
    env: {} as Env,
    organizationId: "org_1",
    projectId: "prj_1",
    walletId: "wal_1",
    owner: OWNER,
    ...overrides,
  }) as Parameters<typeof deriveConfidentialKeysForWallet>[0];

const keys = { elgamal: {}, aes: {} };

beforeEach(() => {
  vi.clearAllMocks();
  createOrgSigner.mockResolvedValue(messageSigner(OWNER));
  deriveConfidentialKeys.mockResolvedValue(keys);
});

describe("deriveConfidentialKeysForWallet", () => {
  // Derivation is wallet-only: one signature, no owner/mint/token-account seed.
  // A reintroduced seed would silently rekey every configured account, so the
  // shape of this call is worth pinning.
  it("derives from the signer alone", async () => {
    await expect(deriveConfidentialKeysForWallet(params())).resolves.toBe(keys);
    expect(deriveConfidentialKeys).toHaveBeenCalledWith({ signer: expect.anything() });
    expect(deriveConfidentialKeys.mock.calls[0][0]).toEqual({
      signer: expect.objectContaining({ address: OWNER }),
    });
  });

  it("resolves the signer for the requested wallet", async () => {
    await deriveConfidentialKeysForWallet(params());
    expect(createOrgSigner).toHaveBeenCalledWith({} as Env, "org_1", "prj_1", "wal_1");
  });

  it("refuses a custody wallet that cannot sign messages", async () => {
    createOrgSigner.mockResolvedValue({ address: OWNER });
    await expect(deriveConfidentialKeysForWallet(params())).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
    expect(deriveConfidentialKeys).not.toHaveBeenCalled();
  });

  // Under the wallet-only scheme the wrong wallet produces valid keys belonging
  // to someone else, which would fail as an opaque proof rejection on-chain.
  it("refuses a signer that is not the account owner", async () => {
    createOrgSigner.mockResolvedValue(messageSigner(OTHER));
    await expect(deriveConfidentialKeysForWallet(params())).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
    expect(deriveConfidentialKeys).not.toHaveBeenCalled();
  });

  it("wraps a derivation failure as a signing failure", async () => {
    deriveConfidentialKeys.mockRejectedValue(new Error("wallet refused"));
    await expect(deriveConfidentialKeysForWallet(params())).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
  });
});

describe("withConfidentialKeys", () => {
  it("releases the keys after a successful run", async () => {
    await expect(withConfidentialKeys(params(), async () => "done")).resolves.toBe("done");
    expect(freeConfidentialKeys).toHaveBeenCalledWith(keys);
  });

  // The keys own WASM memory the garbage collector does not reclaim, so a missing
  // release is invisible until the process dies. The throwing path is the one a
  // refactor is most likely to drop.
  it("releases the keys when the caller throws", async () => {
    await expect(
      withConfidentialKeys(params(), async () => {
        throw new Error("operation failed");
      })
    ).rejects.toThrow("operation failed");
    expect(freeConfidentialKeys).toHaveBeenCalledWith(keys);
  });

  it("does not release anything when derivation itself failed", async () => {
    deriveConfidentialKeys.mockRejectedValue(new Error("wallet refused"));
    await expect(withConfidentialKeys(params(), async () => "unused")).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
    expect(freeConfidentialKeys).not.toHaveBeenCalled();
  });
});
