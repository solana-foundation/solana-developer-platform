import { afterEach, describe, expect, it, vi } from "vitest";
import { explorerAddressUrl, explorerTxUrl } from "./explorer";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("explorerTxUrl", () => {
  it("appends the cluster query for devnet", () => {
    expect(explorerTxUrl("5sig", "devnet")).toBe(
      "https://explorer.solana.com/tx/5sig?cluster=devnet"
    );
  });

  it("omits the cluster query for mainnet-beta (explorer default)", () => {
    expect(explorerTxUrl("5sig", "mainnet-beta")).toBe("https://explorer.solana.com/tx/5sig");
  });

  it("encodes the signature", () => {
    expect(explorerTxUrl("a/b c", "devnet")).toBe(
      "https://explorer.solana.com/tx/a%2Fb%20c?cluster=devnet"
    );
  });
});

describe("explorerAddressUrl", () => {
  it("appends the cluster query for devnet", () => {
    expect(explorerAddressUrl("addr", "devnet")).toBe(
      "https://explorer.solana.com/address/addr?cluster=devnet"
    );
  });

  it("omits the cluster query for mainnet-beta", () => {
    expect(explorerAddressUrl("addr", "mainnet-beta")).toBe(
      "https://explorer.solana.com/address/addr"
    );
  });

  it("encodes the address", () => {
    expect(explorerAddressUrl("a/b", "devnet")).toBe(
      "https://explorer.solana.com/address/a%2Fb?cluster=devnet"
    );
  });
});

/**
 * Against a local validator or a fork, the project's cluster and the network
 * holding its transactions are different networks. Linking by cluster alone
 * opens an explorer page for an account devnet has never seen — which reads as
 * the trade having failed rather than as the link being pointed at the wrong
 * place.
 */
describe("a configured explorer RPC endpoint", () => {
  it("replaces the cluster query on a transaction link", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_EXPLORER_RPC_URL", "http://127.0.0.1:18899");

    expect(explorerTxUrl("5sig", "devnet")).toBe(
      "https://explorer.solana.com/tx/5sig?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A18899%2F"
    );
  });

  it("replaces the cluster query on an address link", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_EXPLORER_RPC_URL", "http://127.0.0.1:18899");

    expect(explorerAddressUrl("addr", "devnet")).toBe(
      "https://explorer.solana.com/address/addr?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A18899%2F"
    );
  });

  // Mainnet's empty query is the one case where overriding could look like a
  // no-op, so it is asserted rather than assumed.
  it("overrides mainnet's empty query too", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_EXPLORER_RPC_URL", "http://127.0.0.1:18899");

    expect(explorerTxUrl("5sig", "mainnet-beta")).toContain("cluster=custom");
  });

  it("ignores a value that is not a URL rather than building a broken link", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_EXPLORER_RPC_URL", "127.0.0.1:18899");

    expect(explorerTxUrl("5sig", "devnet")).toBe(
      "https://explorer.solana.com/tx/5sig?cluster=devnet"
    );
  });

  it("ignores an empty value", () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_EXPLORER_RPC_URL", "   ");

    expect(explorerTxUrl("5sig", "devnet")).toBe(
      "https://explorer.solana.com/tx/5sig?cluster=devnet"
    );
  });
});
