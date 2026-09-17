// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ISSUANCE_LIST_QUERY } from "./issuance-list-query";
import type { IssuanceTokenView } from "./issuance-token-fields";
import { useIssuanceTokenList } from "./use-issuance-token-list";

const mocks = vi.hoisted(() => ({ fetchPage: vi.fn(), replaceSearchParams: vi.fn() }));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({ replaceSearchParams: mocks.replaceSearchParams }),
}));
vi.mock("@/lib/use-debounce", () => ({ useDebounce: (value: string) => value }));
vi.mock("./issuance-tokens-client.data", () => ({
  fetchIssuanceTokensClientPage: mocks.fetchPage,
}));

const existingToken = {
  id: "tok_existing",
  name: "Existing token",
  symbol: "EXT",
  status: "active",
  template: "stablecoin",
  imageUrl: null,
  mintAddress: "5wLf85zhVpJ7xBjDCE1KK8yTXyCrbbzoCUuv3Dwsd5PQ",
  totalSupply: "1",
  createdAt: "2026-01-01T00:00:00.000Z",
  deployedAt: "2026-01-01T00:00:00.000Z",
  decimals: 6,
  maxSupply: null,
  isMintable: true,
  isFreezable: false,
  requiresAllowlist: false,
  description: null,
  uri: null,
  signingCustodyWalletId: null,
  mintAuthority: null,
  metadataAuthority: null,
  freezeAuthority: null,
  permanentDelegate: null,
  assetProfile: null,
} satisfies IssuanceTokenView;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

describe("useIssuanceTokenList", () => {
  beforeEach(() => {
    mocks.fetchPage.mockReset();
    mocks.replaceSearchParams.mockReset();
  });

  it("clears previous-query cards when a malformed no-match search fails", async () => {
    mocks.fetchPage.mockRejectedValue(new Error("Unable to load tokens"));
    const { result } = renderHook(
      () =>
        useIssuanceTokenList({
          initialQuery: DEFAULT_ISSUANCE_LIST_QUERY,
          initialTokens: [existingToken],
          initialTotal: 1,
        }),
      { wrapper }
    );
    expect(result.current.tokens).toEqual([existingToken]);

    act(() => result.current.setSearch("qa-no-match-' OR 1=1 -- 🚀"));

    await waitFor(() => expect(result.current.errorMessage).toBe("Unable to load tokens"));
    expect(result.current.tokens).toEqual([]);
    expect(result.current.total).toBe(0);
  });
});
