// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import { cleanup, render as renderDOM, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { HeaderHost } from "@/test/dashboard-page-title";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ orgId: "org_test", getToken: async () => "test-token" }),
}));

vi.mock("@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider mark</span>,
}));

vi.mock("./use-selected-project-name", () => ({
  useSelectedProjectName: () => "Acme Payments",
}));

import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
} from "./connection-detail.data";
import { ConnectionDetailView } from "./connection-detail-view";

afterEach(() => {
  cleanup();
});

function makeConnection(
  overrides: Partial<CustodyInstallationConnection>
): CustodyInstallationConnection {
  return {
    id: "cconn_1",
    provider: "privy",
    label: "Production signing",
    status: "pending",
    completion: null,
    canComplete: true,
    canReplaceCredentials: true,
    canCancel: true,
    ...overrides,
  };
}

const ACTIVE = makeConnection({ status: "active", canComplete: false, canCancel: false });

function makeWallet(
  walletId: string,
  status: CustodyWalletSummary["status"],
  purpose: string | null
): CustodyWalletSummary {
  return {
    id: `cw_${walletId}`,
    custodyConnectionId: "cconn_1",
    isRuntimeExecutionAllowed: true,
    walletId,
    publicKey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    label: `Wallet ${walletId}`,
    purpose,
    status,
    createdAt: "2026-09-17T13:20:00.000Z",
  };
}

function makeLifecycle(
  connections: CustodyCredentialLifecycle["impact"]["connections"]
): CustodyCredentialLifecycle {
  return {
    providerCredential: {
      id: "pcred_current",
      provider: "privy",
      label: "Privy production app",
      scope: "project",
      projectId: "prj_1",
      status: "active",
      createdAt: "2026-09-09T14:20:00.000Z",
      displayMetadata: { appIdSuffix: "9f2a" },
      source: "stored",
    },
    rotationCandidate: null,
    impact: { projects: [{ id: "prj_1", name: "Acme Payments" }], connections },
    rollback: null,
  };
}

const IN_USE = makeLifecycle([{ id: "cconn_1", projectId: "prj_1", status: "active" }]);
const UNUSED = makeLifecycle([]);

function view({
  connection,
  wallets,
  lifecycle,
  canManageCustody,
}: {
  connection: CustodyInstallationConnection;
  wallets: CustodyWalletSummary[];
  lifecycle: CustodyCredentialLifecycle | "restricted";
  canManageCustody: boolean;
}) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <HeaderHost>
        <ConnectionDetailView
          connection={connection}
          listItem={null}
          lifecycle={lifecycle}
          wallets={wallets}
          walletsUnavailable={false}
          provider="privy"
          canManageCustody={canManageCustody}
        />
      </HeaderHost>
    </I18nProvider>
  );
}

const renderBanner = (connection: CustodyInstallationConnection, canManageCustody: boolean) =>
  renderToStaticMarkup(
    view({ connection, wallets: [], lifecycle: "restricted", canManageCustody })
  );

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
    const html = renderBanner(makeConnection({ completion: unknownCompletion }), true);

    expect(html).toContain(UNKNOWN_TITLE);
    expect(bannerCount(html)).toBe(1);
  });

  it("carries both ways out of the setup on the one banner it keeps", () => {
    const html = renderBanner(makeConnection({ completion: unknownCompletion }), true);

    expect(hasButton(html, "Check current state")).toBe(true);
    expect(hasButton(html, "Cancel setup")).toBe(true);
  });

  it("offers no action a viewer without the role could take", () => {
    const html = renderBanner(makeConnection({ completion: unknownCompletion }), false);

    expect(html).toContain(UNKNOWN_TITLE);
    expect(hasButton(html, "Check current state")).toBe(false);
    expect(hasButton(html, "Cancel setup")).toBe(false);
  });

  // Nothing has been attempted yet, so there is no outcome to report — only the
  // state the connection is in.
  it("falls back to the generic banner when no attempt was recorded", () => {
    const html = renderBanner(makeConnection({ completion: null }), true);

    expect(html).toContain(UNFINISHED_TITLE);
    expect(bannerCount(html)).toBe(1);
  });

  it("leaves a settled connection with no banner at all", () => {
    const html = renderBanner(
      makeConnection({
        status: "active",
        canComplete: false,
        canCancel: false,
        completion: { status: "success", attemptedAt: "2026-09-17T13:20:00.000Z" },
      }),
      true
    );

    expect(bannerCount(html)).toBe(0);
  });

  // Re-checking cannot reconcile a wallet conflict, so the retry is withheld
  // even though the viewer may act and the API would accept the call.
  it("withholds the retry on an outcome that cannot converge", () => {
    const html = renderBanner(
      makeConnection({
        status: "failed",
        completion: {
          status: "failed",
          attemptedAt: "2026-09-17T13:20:00.000Z",
          code: "wallet_conflict",
        },
      }),
      true
    );

    expect(hasButton(html, "Check again")).toBe(false);
    expect(hasButton(html, "Cancel setup")).toBe(true);
  });
});

describe("connection header", () => {
  it("names the connection with its status and starts a rotation from Rotate secret", async () => {
    renderDOM(view({ connection: ACTIVE, wallets: [], lifecycle: IN_USE, canManageCustody: true }));
    const header = screen.getByRole("banner");

    expect(within(header).getByRole("heading", { name: "Production signing" })).toBeTruthy();
    expect(within(header).getByText("Active")).toBeTruthy();
    await userEvent.click(within(header).getByRole("button", { name: "Rotate secret" }));
    expect(await screen.findByRole("dialog", { name: "Rotate credentials" })).toBeTruthy();
  });
});

describe("connection wallets", () => {
  it("lists each wallet under its provider, state and purpose with a short address", () => {
    const html = renderToStaticMarkup(
      view({
        connection: ACTIVE,
        wallets: [
          makeWallet("wal_ops", "active", "Treasury"),
          makeWallet("wal_old", "inactive", null),
          makeWallet("wal_fees", "active", "fee_payer"),
        ],
        lifecycle: "restricted",
        canManageCustody: true,
      })
    );

    expect(html).toContain('href="/dashboard/prj_test_sandbox/wallets/wal_ops"');
    expect(html).toContain("Privy · Treasury");
    expect(html).toContain("Privy · inactive");
    expect(html).toContain("Privy · Fee payer");
    expect(html).toContain("7xKX...gAsU");
    expect(hasButton(html, "Add wallet")).toBe(true);
  });

  it("marks wallets read-only and offers no new one once the connection is deactivated", () => {
    const html = renderToStaticMarkup(
      view({
        connection: makeConnection({ status: "deactivated", canComplete: false, canCancel: false }),
        wallets: [makeWallet("wal_ops", "active", "Treasury")],
        lifecycle: "restricted",
        canManageCustody: true,
      })
    );

    expect(html).toContain("Privy · Read-only · Treasury");
    expect(hasButton(html, "Add wallet")).toBe(false);
  });
});

describe("danger zone", () => {
  it.each([
    ["an unfinished setup", makeConnection({}), [], true, false, false],
    ["an active wallet", ACTIVE, [makeWallet("wal_ops", "active", null)], true, true, false],
    ["only inactive wallets", ACTIVE, [makeWallet("wal_old", "inactive", null)], true, false, true],
    ["a viewer who cannot manage custody", ACTIVE, [], false, false, false],
  ] as const)(
    "decides the deactivate-connection control for %s",
    (_case, connection, wallets, canManageCustody, disclosure, button) => {
      const html = renderToStaticMarkup(
        view({ connection, wallets: [...wallets], lifecycle: "restricted", canManageCustody })
      );

      expect(html).toContain("Danger zone");
      expect(html.includes("1 wallet still active")).toBe(disclosure);
      expect(hasButton(html, "Deactivate connection")).toBe(button);
    }
  );

  it("lists the active wallets that block deactivation as links", async () => {
    renderDOM(
      view({
        connection: ACTIVE,
        wallets: [
          makeWallet("wal_ops", "active", null),
          makeWallet("wal_pay", "active", null),
          makeWallet("wal_old", "inactive", null),
        ],
        lifecycle: "restricted",
        canManageCustody: true,
      })
    );
    const disclosure = screen.getByRole("button", { name: "2 wallets still active" });

    await userEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const linksTo = (name: string) =>
      screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));
    expect(linksTo("Wallet wal_ops")).toEqual([
      "/dashboard/prj_test_sandbox/wallets/wal_ops",
      "/dashboard/prj_test_sandbox/wallets/wal_ops",
    ]);
    expect(linksTo("Wallet wal_pay")).toHaveLength(2);
    expect(linksTo("Wallet wal_old")).toHaveLength(1);
  });

  it.each([
    ["restricted", "restricted", false],
    ["unused stored", UNUSED, true],
  ] as const)(
    "shows a deactivated connection's danger zone only for deactivatable credentials (%s)",
    (_case, lifecycle, shown) => {
      const html = renderToStaticMarkup(
        view({
          connection: makeConnection({
            status: "deactivated",
            canComplete: false,
            canCancel: false,
          }),
          wallets: [],
          lifecycle,
          canManageCustody: true,
        })
      );

      expect(html.includes("Danger zone")).toBe(shown);
      expect(hasButton(html, "Deactivate credentials")).toBe(shown);
      expect(html).not.toContain(">Deactivate connection<");
    }
  );

  it("opens the credential deactivation from its row", async () => {
    renderDOM(
      view({
        connection: makeConnection({ status: "deactivated", canComplete: false, canCancel: false }),
        wallets: [],
        lifecycle: UNUSED,
        canManageCustody: true,
      })
    );

    await userEvent.click(screen.getByRole("button", { name: "Deactivate credentials" }));

    expect(
      await screen.findByRole("dialog", { name: "Deactivate “Privy production app” credentials?" })
    ).toBeTruthy();
  });
});
