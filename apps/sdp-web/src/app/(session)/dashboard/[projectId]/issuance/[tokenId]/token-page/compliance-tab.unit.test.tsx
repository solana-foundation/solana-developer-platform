// @vitest-environment jsdom

import type { Token, TokenAllowlistEntry } from "@sdp/types/tokens";
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenAllowlistPage } from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/allowlist.data";
import { EnglishI18n } from "@/test/i18n";
import { TokenComplianceTab } from "./compliance-tab";
import type { TokenTabProps } from "./token-page.shared";

const mocks = vi.hoisted(() => ({ total: 0 }));

vi.mock(
  "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/allowlist.data",
  () => ({
    fetchTokenAllowlistPage: async (): Promise<TokenAllowlistPage> => ({
      entries: Array.from({ length: mocks.total }, (_, index) => entry(index)),
      total: mocks.total,
      hasMore: false,
      page: 1,
      pageSize: 25,
    }),
  })
);

/** An approved address on the token's list. */
function entry(index: number): TokenAllowlistEntry {
  return {
    id: `tal_${index}`,
    tokenId: "tok_test",
    address: `Approved${index}1111111111111111111111111111111`,
    label: null,
    status: "active",
    addedBy: "user_test",
    createdAt: "2026-11-05T00:00:00.000Z",
    revokedAt: null,
  };
}

/** The tab over an approved-recipients token whose list holds `mocks.total` addresses. */
function renderTab(frozenAccountsTotal: number) {
  const props = {
    token: { id: "tok_test", mintAddress: "Mint111111111111111111111111111111111111111" } as Token,
    ops: {
      accessControlMode: "allowlist",
      complianceActionDisabledReasons: {},
      frozenAccountsError: null,
      frozenAccountsTotal,
      isPending: false,
      handleRemoveAllowlist: vi.fn(),
    },
    canManageTokenAdmin: false,
  } as unknown as TokenTabProps;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <EnglishI18n>
        <TokenComplianceTab {...props} />
      </EnglishI18n>
    </SWRConfig>
  );
}

describe("TokenComplianceTab", () => {
  afterEach(cleanup);

  it.each([
    { total: 1, frozen: 1, entries: "1 entry", accounts: "1 account" },
    { total: 2, frozen: 0, entries: "2 entries", accounts: "0 accounts" },
    { total: 3, frozen: 2, entries: "3 entries", accounts: "2 accounts" },
  ])(
    "counts $total listed and $frozen frozen as $entries and $accounts",
    async ({ total, frozen, entries, accounts }) => {
      mocks.total = total;
      renderTab(frozen);
      expect(await screen.findByText(entries)).toBeTruthy();
      expect(screen.getByText(accounts)).toBeTruthy();
    }
  );
});
