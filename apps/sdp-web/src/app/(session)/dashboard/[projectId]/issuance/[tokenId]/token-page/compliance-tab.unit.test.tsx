// @vitest-environment jsdom

import type { Token, TokenAllowlistEntry } from "@sdp/types/tokens";
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as allowlistData from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/allowlist.data";
import * as operationData from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/use-token-operation-data";
import { useTokenOperations } from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/asset-profile/use-token-operations";
import * as actionRunner from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/use-token-action-runner";
import * as workspace from "@/contexts/dashboard-workspace-context";
import { EnglishI18n } from "@/test/i18n";
import { TokenComplianceTab } from "./compliance-tab";

const AUTHORITY = "3yQfmv9WiotYSDmamiow5Xt2abcvDxTzmFBSYEEGZtqe";

/** A deployed token that only approved addresses may receive. */
const TOKEN: Token = {
  id: "tok_test",
  projectId: "prj_test",
  organizationId: "org_test",
  signingCustodyWalletId: "cw_ops",
  signingWalletId: "wal_ops",
  mintAddress: "5wLf85zhVpJ7xBjDCE1KK8yTXyCrbbzoCUuv3Dwsd5PQ",
  mintAuthority: AUTHORITY,
  metadataAuthority: AUTHORITY,
  freezeAuthority: AUTHORITY,
  ablListAddress: null,
  name: "Acme Dollar",
  symbol: "ACME",
  decimals: 6,
  description: null,
  uri: null,
  imageUrl: null,
  template: "stablecoin",
  extensions: {},
  totalSupply: "1000000",
  maxSupply: null,
  isMintable: true,
  isFreezable: true,
  requiresAllowlist: true,
  status: "active",
  deployedAt: "2026-11-05T00:00:00.000Z",
  createdBy: "user_test",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

/** An approved address on the token's list. */
function entry(index: number): TokenAllowlistEntry {
  return {
    id: `tal_${index}`,
    tokenId: TOKEN.id,
    address: `Approved${index}1111111111111111111111111111111`,
    label: null,
    status: "active",
    addedBy: "user_test",
    createdAt: "2026-11-05T00:00:00.000Z",
    revokedAt: null,
  };
}

/** The list holds `listed` addresses and `frozen` accounts are frozen; nothing else is read. */
function stubCompliance(listed: number, frozen: number) {
  vi.mocked(vi.spyOn(workspace, "useDashboardWorkspace"), { partial: true }).mockReturnValue({
    sdpEnvironment: "sandbox",
  });
  vi.mocked(vi.spyOn(actionRunner, "useTokenActionRunner"), { partial: true }).mockReturnValue({
    isPending: false,
  });
  vi.mocked(vi.spyOn(operationData, "useTokenOperationData"), { partial: true }).mockReturnValue({
    authorityWallets: [],
    authorityWalletsError: null,
    authorityWalletsLoading: false,
    allowlistEntries: [],
    frozenAccountsError: null,
    frozenAccountsLoading: false,
    frozenAccountsTotal: frozen,
  });
  vi.spyOn(allowlistData, "fetchTokenAllowlistPage").mockResolvedValue({
    entries: Array.from({ length: listed }, (_, index) => entry(index)),
    total: listed,
    hasMore: false,
    page: 1,
    pageSize: 25,
  });
}

/** The tab over the token's own operations, as its page renders it. */
function ComplianceTab() {
  const ops = useTokenOperations({
    token: TOKEN,
    shouldLoadAuthorityWallets: true,
    canManageTokenAdmin: false,
  });
  return <TokenComplianceTab token={TOKEN} ops={ops} canManageTokenAdmin={false} />;
}

describe("TokenComplianceTab", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    { listed: 1, frozen: 1, entries: "1 entry", accounts: "1 account" },
    { listed: 2, frozen: 0, entries: "2 entries", accounts: "0 accounts" },
    { listed: 3, frozen: 2, entries: "3 entries", accounts: "2 accounts" },
  ])(
    "counts $listed listed and $frozen frozen as $entries and $accounts",
    async ({ listed, frozen, entries, accounts }) => {
      stubCompliance(listed, frozen);
      render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <EnglishI18n>
            <ComplianceTab />
          </EnglishI18n>
        </SWRConfig>
      );
      expect(await screen.findByText(entries)).toBeTruthy();
      expect(screen.getByText(accounts)).toBeTruthy();
    }
  );
});
