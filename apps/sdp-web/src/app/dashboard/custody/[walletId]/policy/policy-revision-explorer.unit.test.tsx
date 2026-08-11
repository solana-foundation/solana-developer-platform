import type { WalletControlProfileRevisionHistory } from "@sdp/types";
import { wellKnownMint } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { explorerAddressUrl } from "@/lib/explorer";

vi.mock("@/lib/use-solana-cluster", () => ({
  useSolanaCluster: () => "devnet",
}));

import { PolicyRevisionExplorer } from "./policy-revision-explorer";

const USDC_DEVNET_MINT = wellKnownMint("USDC", "devnet");
const CUSTOM_MINT = "CustomMint1111111111111111111111111111111111";
const ALLOWED_DESTINATION = "Dest111111111111111111111111111111111111111";

const history: WalletControlProfileRevisionHistory = {
  profile: null,
  revisions: [
    {
      id: "revision-2",
      profileId: "profile-1",
      revisionNumber: 2,
      rules: [
        {
          id: "rule-assets",
          kind: "asset",
          action: "allow",
          assets: [String(USDC_DEVNET_MINT), CUSTOM_MINT],
        },
        {
          id: "rule-destinations",
          kind: "destination",
          action: "deny",
          allowlist: [ALLOWED_DESTINATION],
        },
      ],
      defaultAction: "allow",
      commitMessage: "Restrict assets and blocked destinations.",
      createdBy: "usr_creator",
      createdAt: "2026-08-01T10:00:00.000Z",
      activatedAt: "2026-08-01T10:05:00.000Z",
      isActive: true,
    },
    {
      id: "revision-1",
      profileId: "profile-1",
      revisionNumber: 1,
      rules: [],
      defaultAction: "allow",
      commitMessage: null,
      createdBy: null,
      createdAt: "2026-07-18T13:30:00.000Z",
      activatedAt: null,
      isActive: false,
    },
  ],
};

function renderExplorer(props: Partial<Parameters<typeof PolicyRevisionExplorer>[0]> = {}) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PolicyRevisionExplorer history={history} {...props} />
    </I18nProvider>
  );
}

describe("policy revision explorer", () => {
  it("renders the empty state when no revisions exist", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PolicyRevisionExplorer history={{ profile: null, revisions: [] }} />
      </I18nProvider>
    );

    expect(html).toContain("No policy revisions yet");
    expect(html).not.toContain("Revision #");
  });

  it("shows the newest revision when no or an unknown revision id is requested", () => {
    for (const initialRevisionId of [undefined, "revision-missing"]) {
      const html = renderExplorer({ initialRevisionId });

      expect(html).toContain('aria-current="true"');
      expect(html).toContain("Revision #2");
      expect(html).toContain("Allowed assets");
    }
  });

  it("snapshots the requested revision when its id exists", () => {
    const html = renderExplorer({ initialRevisionId: "revision-1" });

    expect(html).toContain("No explicit rules were stored in this revision.");
    expect(html).not.toContain("Allowed assets");
  });

  it("labels creators from the member directory and falls back to System", () => {
    const html = renderExplorer({ userNames: { usr_creator: "Ada Lovelace" } });

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(">AL<");

    const systemRevision = renderExplorer({ initialRevisionId: "revision-1" });
    expect(systemRevision).toContain("System");
  });

  it("marks the active revision and flags never-activated revisions as drafts", () => {
    const html = renderExplorer();

    expect(html).toContain("Active");
    expect(html).toContain("Draft");
  });

  it("shows commit messages and an italic placeholder for revisions without one", () => {
    const html = renderExplorer();

    expect(html).toContain("Restrict assets and blocked destinations.");
    expect(html).toContain("No revision message");
  });

  it("links destinations to the active project cluster on Solana Explorer", () => {
    const html = renderExplorer();

    expect(html).toContain(explorerAddressUrl(ALLOWED_DESTINATION, "devnet"));
    expect(html).toContain("cluster=devnet");
  });

  it("resolves well-known asset mints to their symbol and keeps custom mints verbatim", () => {
    const html = renderExplorer();

    expect(html).toContain("USDC");
    expect(html).toContain(CUSTOM_MINT);
  });

  it("groups rules of one classification into a single section", () => {
    const grouped: WalletControlProfileRevisionHistory = {
      profile: null,
      revisions: [
        {
          ...history.revisions[0],
          rules: [
            {
              id: "rule-family-payment",
              kind: "operation_family",
              action: "allow",
              family: "payment",
            },
            {
              id: "rule-family-issuance",
              kind: "operation_family",
              action: "deny",
              family: "issuance",
            },
            {
              id: "rule-type",
              kind: "operation_type",
              action: "allow",
              operationType: "payment_transfer",
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PolicyRevisionExplorer history={grouped} />
      </I18nProvider>
    );

    expect(html.match(/Operation controls/g)).toHaveLength(1);
    expect(html.match(/View raw rule data/g)).toHaveLength(1);
    expect(html).toContain("Payments");
    expect(html).toContain("Issuance");
    expect(html).not.toContain("Families");
  });
});
