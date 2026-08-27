import { ClientError } from "@heliuslabs/zolana/client";
import { InterfaceError } from "@heliuslabs/zolana/interface";
import { TransactionError } from "@heliuslabs/zolana/transaction";
import { WalletError } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError, type HeliusRingsErrorCode } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { withZolanaErrorBridge } from "./error-bridge.js";

const RPC_URL_WITH_KEY = "https://devnet.helius-rpc.com/?api-key=super-secret-key";

async function bridge(error: unknown): Promise<unknown> {
  return withZolanaErrorBridge(() => Promise.reject(error)).then(
    () => null,
    (thrown: unknown) => thrown
  );
}

async function codeFor(error: unknown): Promise<HeliusRingsErrorCode> {
  const thrown = await bridge(error);
  expect(thrown).toBeInstanceOf(HeliusRingsError);
  return (thrown as HeliusRingsError).code;
}

describe("withZolanaErrorBridge", () => {
  it("passes a successful result through", async () => {
    await expect(withZolanaErrorBridge(async () => "ok")).resolves.toBe("ok");
  });

  it("treats an unlisted client or wallet failure as an unavailable upstream", async () => {
    await expect(codeFor(new ClientError("CLIENT_RPC", { details: {} }))).resolves.toBe(
      "gateway_unavailable"
    );
    await expect(codeFor(new WalletError("WALLET_SYNC"))).resolves.toBe("gateway_unavailable");
  });

  it("treats an unlisted interface or transaction failure as bad input", async () => {
    await expect(codeFor(new InterfaceError("INTERFACE_INVALID_SHAPE"))).resolves.toBe(
      "invalid_input"
    );
    await expect(codeFor(new TransactionError("TRANSACTION_INVALID_AMOUNT"))).resolves.toBe(
      "invalid_input"
    );
  });

  // The ones the default would misroute: an operator sent to a retry button for a
  // misconfiguration, or to the environment for a real conflict.
  it.each([
    ["CLIENT_INVALID_CONFIG", new ClientError("CLIENT_INVALID_CONFIG"), "config_error"],
    [
      "CLIENT_UNSUPPORTED_RPC_METHOD",
      new ClientError("CLIENT_UNSUPPORTED_RPC_METHOD", { details: { method: "getSlot" } }),
      "config_error",
    ],
    [
      "CLIENT_TREE_MISMATCH",
      new ClientError("CLIENT_TREE_MISMATCH", {
        details: { transactionTree: "a", clientTree: "b" },
      }),
      "conflict",
    ],
  ] as const)("classifies %s as %s", async (_code, error, expected) => {
    await expect(codeFor(error)).resolves.toBe(expected);
  });

  it.each([
    ["WALLET_INVALID_SYNC_CONFIG", "config_error"],
    ["WALLET_USER_RECORD_OWNER_MISMATCH", "conflict"],
    ["WALLET_INVALID_ADDRESS", "invalid_input"],
    ["WALLET_INVALID_AMOUNT", "invalid_input"],
  ] as const)("classifies %s as %s", async (code, expected) => {
    await expect(codeFor(new WalletError(code))).resolves.toBe(expected);
  });

  it("prefers the specific error a wallet wrapper retained over the wrapper's own code", async () => {
    // WALLET_SYNC alone would be an unavailable upstream; the retained cause says
    // the tree is wrong, which is a conflict nobody should retry.
    const wrapped = new WalletError("WALLET_SYNC", {
      cause: new ClientError("CLIENT_TREE_MISMATCH", {
        details: { transactionTree: "a", clientTree: "b" },
      }),
    });

    await expect(codeFor(wrapped)).resolves.toBe("conflict");
  });

  it("rethrows anything that is not a public Zolana error", async () => {
    const foreign = new Error("something else entirely");

    await expect(bridge(foreign)).resolves.toBe(foreign);
  });

  it("keeps the upstream message, cause and details out of what it throws", async () => {
    const upstream = new ClientError("CLIENT_INDEXER", {
      details: { method: "getIndexerHealth", retryable: true },
      cause: new Error(`fetch failed for ${RPC_URL_WITH_KEY}`),
    });

    const thrown = (await bridge(upstream)) as HeliusRingsError;

    // A message quoting the endpoint would publish the API key in the RPC URL,
    // and a chained cause carries it just as far.
    expect(thrown.message).toBe("a Rings upstream service is unavailable");
    expect(thrown.cause).toBeUndefined();
    expect(JSON.stringify({ message: thrown.message })).not.toContain("super-secret-key");
  });
});
