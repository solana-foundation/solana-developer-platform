import { AppError } from "@/lib/errors";
import { describe, expect, it } from "vitest";
import { parseWalletBindingPatch } from "./wallet-bindings";

describe("wallet bindings parser", () => {
  it("supports legacy single signingWalletId payloads", () => {
    const parsed = parseWalletBindingPatch({
      signingWalletId: "wal_legacy",
    });

    expect(parsed.defaultSigningWalletId).toBe("wal_legacy");
    expect(parsed.bindings).toEqual([{ walletId: "wal_legacy", permissions: ["*"] }]);
  });

  it("merges signingWalletIds and walletBindings", () => {
    const parsed = parseWalletBindingPatch({
      signingWalletIds: ["wal_a", "wal_b"],
      walletBindings: [
        { walletId: "wal_b", permissions: ["payments:write"] },
        { walletId: "wal_c", permissions: ["tokens:write"] },
      ],
    });

    expect(parsed.defaultSigningWalletId).toBe("wal_b");
    expect(parsed.bindings).toEqual([
      { walletId: "wal_b", permissions: ["payments:write"] },
      { walletId: "wal_c", permissions: ["tokens:write"] },
      { walletId: "wal_a", permissions: ["*"] },
    ]);
  });

  it("clears all wallet bindings when null patch is provided", () => {
    const parsed = parseWalletBindingPatch({
      signingWalletIds: null,
    });

    expect(parsed.defaultSigningWalletId).toBeNull();
    expect(parsed.bindings).toEqual([]);
  });

  it("rejects conflicting null and non-null wallet patch fields", () => {
    expect(() =>
      parseWalletBindingPatch({
        signingWalletIds: null,
        signingWalletId: "wal_conflict",
      })
    ).toThrowError(AppError);
  });
});
