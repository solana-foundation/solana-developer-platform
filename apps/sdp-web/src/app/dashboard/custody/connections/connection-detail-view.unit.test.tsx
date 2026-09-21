import type { CustodyWalletSummary } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/dashboard/custody/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider mark</span>,
}));

vi.mock("@/app/dashboard/custody/connections/use-selected-project-name", () => ({
  useSelectedProjectName: () => "Acme Payments",
}));

vi.mock("./use-selected-project-name", () => ({
  useSelectedProjectName: () => "Acme Payments",
}));

import type { CustodyInstallationConnection } from "./connection-detail.data";
import { ConnectionDetailView } from "./connection-detail-view";

function makeConnection(
  overrides: Partial<CustodyInstallationConnection> = {}
): CustodyInstallationConnection {
  return {
    id: "cconn_1",
    provider: "privy",
    label: "Production signing",
    status: "pending",
    completion: null,
    isDefault: false,
    canComplete: true,
    canReplaceCredentials: true,
    canCancel: true,
    ...overrides,
  };
}

function render({
  connection,
  wallets = [],
  canManageCustody = true,
}: {
  connection: CustodyInstallationConnection;
  wallets?: CustodyWalletSummary[];
  canManageCustody?: boolean;
}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ConnectionDetailView
        connection={connection}
        listItem={null}
        lifecycle="restricted"
        wallets={wallets}
        walletsUnavailable={false}
        provider="privy"
        canManageCustody={canManageCustody}
      />
    </I18nProvider>
  );
}

const UNFINISHED_TITLE = "Setup is not finished";
const UNKNOWN_TITLE = "We could not confirm whether verification finished";

/**
 * Whether the page rendered that control as a button.
 *
 * Matched on the button's own label markup rather than the bare words: the
 * deactivate card's blocking reason says "use Cancel setup above", and a plain
 * substring check counts that sentence as an offered action.
 */
function hasButton(html: string, label: string): boolean {
  return html.includes(`<span>${label}</span>`);
}

/** How many of the two setup banners the page rendered. */
function bannerCount(html: string): number {
  return [UNFINISHED_TITLE, UNKNOWN_TITLE].filter((title) => html.includes(title)).length;
}

describe("connection detail banners", () => {
  const unknownCompletion = {
    status: "retry_unknown" as const,
    attemptedAt: "2026-09-17T13:20:00.000Z",
  };

  // The two used to stack: "Setup is not finished" over "We could not confirm
  // whether verification finished", each with its own re-check button.
  it("states an unconfirmed outcome once, not beside a second banner", () => {
    const html = render({ connection: makeConnection({ completion: unknownCompletion }) });

    expect(html).toContain(UNKNOWN_TITLE);
    expect(bannerCount(html)).toBe(1);
  });

  it("carries both ways out of the setup on the one banner it keeps", () => {
    const html = render({ connection: makeConnection({ completion: unknownCompletion }) });

    expect(hasButton(html, "Check current state")).toBe(true);
    expect(hasButton(html, "Cancel setup")).toBe(true);
  });

  it("offers no action a viewer without the role could take", () => {
    const html = render({
      connection: makeConnection({ completion: unknownCompletion }),
      canManageCustody: false,
    });

    expect(html).toContain(UNKNOWN_TITLE);
    expect(hasButton(html, "Check current state")).toBe(false);
    expect(hasButton(html, "Cancel setup")).toBe(false);
  });

  // Nothing has been attempted yet, so there is no outcome to report — only the
  // state the connection is in.
  it("falls back to the generic banner when no attempt was recorded", () => {
    const html = render({ connection: makeConnection({ completion: null }) });

    expect(html).toContain(UNFINISHED_TITLE);
    expect(bannerCount(html)).toBe(1);
  });

  it("leaves a settled connection with no banner at all", () => {
    const html = render({
      connection: makeConnection({
        status: "active",
        canComplete: false,
        canCancel: false,
        completion: { status: "success", attemptedAt: "2026-09-17T13:20:00.000Z" },
      }),
    });

    expect(bannerCount(html)).toBe(0);
  });

  // Re-checking cannot reconcile a wallet conflict, so the retry is withheld
  // even though the viewer may act and the API would accept the call.
  it("withholds the retry on an outcome that cannot converge", () => {
    const html = render({
      connection: makeConnection({
        status: "failed",
        completion: {
          status: "failed",
          attemptedAt: "2026-09-17T13:20:00.000Z",
          code: "wallet_conflict",
        },
      }),
    });

    expect(hasButton(html, "Check again")).toBe(false);
    expect(hasButton(html, "Cancel setup")).toBe(true);
  });
});

describe("connection wallets table", () => {
  // `colSpan` is a fixed number and cannot follow the container query that hides
  // the Created column, so spanning all four gave the table a phantom column the
  // header row did not cover.
  it("spans the empty-state row over exactly the columns that are always there", () => {
    const html = render({ connection: makeConnection() });

    expect(html).toContain("No wallets yet");
    expect(html).toContain('colSpan="3"');
    expect(html).not.toContain('colSpan="4"');
  });

  it("declares the container the Created column measures itself against", () => {
    const html = render({ connection: makeConnection() });

    expect(html).toContain("@container/connection-wallets");
  });
});
