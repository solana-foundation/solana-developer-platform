import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getChannelTokenBalance } from "./gateway";

// Devnet USDC (classic Token program) + a real devnet account as the owner.
const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const OWNER = address("7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz");

/** A `@solana/kit` HTTP-transport error carries the status on `error.context`. */
function httpError(statusCode: number) {
  return { context: { statusCode }, message: `HTTP error (${statusCode})` };
}

/** Minimal fake of the Kit RPC surface the gateway helper touches. Either call can
 *  be made to reject, to exercise the gateway's HTTP-status handling. */
function fakeRpc(overrides: {
  accountInfo?: unknown;
  accountInfoError?: unknown;
  tokenBalance?: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
  tokenBalanceError?: unknown;
}) {
  return {
    getAccountInfo: () => ({
      send: async () => {
        if (overrides.accountInfoError) throw overrides.accountInfoError;
        return { value: overrides.accountInfo ?? null };
      },
    }),
    getTokenAccountBalance: () => ({
      send: async () => {
        if (overrides.tokenBalanceError) throw overrides.tokenBalanceError;
        return { value: overrides.tokenBalance };
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled test double for the Kit RPC.
  } as any;
}

describe("getChannelTokenBalance", () => {
  it("derives the classic-Token ATA deterministically", async () => {
    const a = await getChannelTokenBalance(fakeRpc({ accountInfo: null }), OWNER, USDC);
    const b = await getChannelTokenBalance(fakeRpc({ accountInfo: null }), OWNER, USDC);
    expect(a.tokenAccount).toBe(b.tokenAccount);
    expect(a.tokenAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("returns balance null when the channel token account does not exist", async () => {
    const result = await getChannelTokenBalance(fakeRpc({ accountInfo: null }), OWNER, USDC);
    expect(result.balance).toBeNull();
  });

  it("maps the gateway token balance when the account exists", async () => {
    const result = await getChannelTokenBalance(
      fakeRpc({
        accountInfo: { lamports: 2039280n },
        tokenBalance: { amount: "1500000", decimals: 6, uiAmount: 1.5, uiAmountString: "1.5" },
      }),
      OWNER,
      USDC
    );
    expect(result.balance).toEqual({ amount: "1500000", decimals: 6, uiAmountString: "1.5" });
  });

  it("treats a 403 on the existence probe as an absent (zero) account", async () => {
    // The SPC gateway answers a never-credited / not-owned account with HTTP 403
    // ("account not owned by caller") instead of a null result — read as zero.
    const result = await getChannelTokenBalance(
      fakeRpc({ accountInfoError: httpError(403) }),
      OWNER,
      USDC
    );
    expect(result.balance).toBeNull();
  });

  it("propagates a 401 from the existence probe (auth refresh is handled upstream)", async () => {
    const err = httpError(401);
    await expect(
      getChannelTokenBalance(fakeRpc({ accountInfoError: err }), OWNER, USDC)
    ).rejects.toBe(err);
  });

  it("propagates a 5xx from the existence probe rather than masking it as zero", async () => {
    const err = httpError(503);
    await expect(
      getChannelTokenBalance(fakeRpc({ accountInfoError: err }), OWNER, USDC)
    ).rejects.toBe(err);
  });

  it("does NOT mask a 403 from the balance read once the account is known to exist", async () => {
    // The probe confirmed the account exists and is the caller's; a forbidden
    // balance read afterward is anomalous and must surface, not read as zero.
    const err = httpError(403);
    await expect(
      getChannelTokenBalance(
        fakeRpc({ accountInfo: { lamports: 2039280n }, tokenBalanceError: err }),
        OWNER,
        USDC
      )
    ).rejects.toBe(err);
  });
});
