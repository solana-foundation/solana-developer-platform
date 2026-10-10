// @vitest-environment jsdom
import type { FireblocksPolicySetup } from "@sdp/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { FireblocksTransferPolicy } from "./fireblocks-transfer-policy";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: vi.fn() }));
const selection = {
  walletId: "wallet",
  counterpartyId: "contact",
  accountId: "address",
  address: "destination",
  token: "SOL",
  amount: "0.01",
};
const setup: FireblocksPolicySetup = {
  revision: "revision",
  sourceName: "Treasury",
  sourceVaultId: "0",
  assetId: "SOL",
  initiatorName: "SDP API user",
  destinationWhitelisted: true,
  people: [
    { id: "thomas", name: "Thomas Fischer", role: "OWNER", canSign: true },
    { id: "keegan", name: "Keegan Thompson", role: "APPROVER", canSign: false },
  ],
  groups: [{ id: "team", name: "Treasury approvers", memberIds: ["thomas", "keegan"] }],
  defaults: {
    name: "Created within SDP — SOL from Treasury to whitelisted addresses",
    destination: "all_whitelisted",
    approvalGroups: [{ users: [], groups: [], threshold: 1 }],
    approvalOperator: "AND",
    signerMode: "SINGLE",
    signerIds: [],
  },
};
function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}
function ok(data: unknown) {
  return { ok: true as const, status: 200, data: { data } };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("Fireblocks transfer policy UI", () => {
  it("explains denied policy access without offering to create a rule", async () => {
    vi.mocked(dashboardFetch).mockResolvedValue(
      ok({ state: "permission_required", canConfigure: false })
    );
    render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    expect(await screen.findByText(/API user cannot read policies/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up transfer policy" })).toBeNull();
    expect(
      vi
        .mocked(dashboardFetch)
        .mock.calls.every(([, options]) => !options?.method || options.method === "GET")
    ).toBe(true);
  });
  it("requires selecting humans and separates saving from submitting the policy", async () => {
    const writes: string[] = [];
    vi.mocked(dashboardFetch).mockImplementation(async (path, options) => {
      if (path.includes("/setup?")) return ok(setup);
      if (options?.method === "POST") {
        writes.push(path);
        return ok({
          proposalId: "proposal",
          state: path.endsWith("/publish") ? "submitted" : "draft",
        });
      }
      return ok({ state: "missing", canConfigure: true });
    });
    const user = userEvent.setup();
    render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    await user.click(await screen.findByRole("button", { name: "Set up transfer policy" }));
    const save = await screen.findByRole("button", { name: "Save Fireblocks draft" });
    expect(save).toHaveProperty("disabled", true);
    expect(screen.getByText("Cannot approve")).toBeTruthy();
    expect(screen.getByText("Unlimited USD")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approver set 1" }));
    await user.click(await screen.findByRole("button", { name: "Treasury approvers" }));
    await user.click(screen.getByRole("button", { name: "Choose signers" }));
    expect(screen.queryByRole("button", { name: "Keegan Thompson" })).toBeNull();
    expect(screen.queryByRole("button", { name: "SDP API user" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Thomas Fischer" }));
    expect(save).toHaveProperty("disabled", false);
    expect(writes).toEqual([]);
    await user.click(save);
    const publish = await screen.findByRole("button", { name: "Submit policy for approval" });
    expect(writes).toEqual(["/api/dashboard/fireblocks/policy/draft"]);
    await user.click(publish);
    await waitFor(() =>
      expect(writes).toEqual([
        "/api/dashboard/fireblocks/policy/draft",
        "/api/dashboard/fireblocks/policy/publish",
      ])
    );
    expect(await screen.findByText(/Policy submitted to Fireblocks/)).toBeTruthy();
  });
  it("drops a stale policy reply when the destination changes", async () => {
    let resolveFirst: ((value: ReturnType<typeof ok>) => void) | undefined;
    vi.mocked(dashboardFetch)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue(ok({ state: "covered", canConfigure: false }));
    const view = render(<FireblocksTransferPolicy enabled selection={selection} />, { wrapper });
    await waitFor(() => expect(resolveFirst).toBeDefined());
    view.rerender(
      <FireblocksTransferPolicy enabled selection={{ ...selection, address: "another" }} />
    );
    resolveFirst?.(ok({ state: "missing", canConfigure: true }));
    expect(await screen.findByText(/A Fireblocks transfer rule matches/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up transfer policy" })).toBeNull();
  });
});
