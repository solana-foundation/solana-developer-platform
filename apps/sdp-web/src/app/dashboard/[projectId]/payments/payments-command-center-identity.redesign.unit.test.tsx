// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as activityPanels from "./payments-activity-panels";
import { PaymentsCommandCenter } from "./payments-command-center.redesign";

vi.mock("@/lib/sdp-api", () => ({ requestProjectId: async () => "prj_test_sandbox" }));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));
vi.mock("@/flags/ramps", () => ({ getEnabledRampProviders: async () => [] }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("command center wallet identity", () => {
  it("joins exact pins and keeps the previous labels for unresolved or unavailable wallets", async () => {
    const panels = vi.spyOn(activityPanels, "PaymentsActivityPanels");
    const request = vi.fn(async (path: string) => {
      if (path === "/v1/organizations/org/provider-access") {
        return Response.json({ data: { providers: { compliance: {}, ramps: {} } } });
      }
      if (path.startsWith("/v1/payments/transfers?")) {
        return Response.json({
          data: [
            {
              id: "exact",
              custodyWalletId: "wallet-b",
              providerWalletId: "provider-alias",
              source: "shared-address",
              rampsMemo: {},
              status: "confirmed",
              direction: "outbound",
            },
            {
              id: "unresolved",
              custodyWalletId: null,
              providerWalletId: "provider-alias",
              source: "saved-source",
              rampsMemo: {},
              status: "confirmed",
              direction: "outbound",
            },
            {
              id: "unavailable",
              custodyWalletId: "wallet-gone",
              providerWalletId: "provider-alias",
              destination: "saved-recipient",
              rampsMemo: {},
              status: "completed",
              direction: "inbound",
            },
          ],
        });
      }
      if (path.startsWith("/v1/payments/transfer-batches?")) {
        return Response.json({
          data: [
            {
              id: "batch",
              sourceCustodyWalletId: null,
              sourceProviderWalletId: "provider-alias",
              sourceAddress: "saved-batch-source",
              token: "SOL",
              status: "completed",
              recipientCount: 1,
              transactionCount: 1,
            },
          ],
        });
      }
      if (path.startsWith("/v1/wallets?")) {
        return Response.json({
          data: {
            wallets: [
              {
                id: "wallet-a",
                walletId: "provider-alias",
                publicKey: "shared-address",
                label: "Wallet A",
                custodyConfigId: "config",
                isRuntimeExecutionAllowed: true,
              },
              {
                id: "wallet-b",
                walletId: "provider-alias",
                publicKey: "shared-address",
                label: "Wallet B",
                custodyConnectionId: "connection",
                isRuntimeExecutionAllowed: true,
              },
            ],
          },
        });
      }
      return Response.json({ data: [] });
    });
    const stream = await renderToReadableStream(
      <PaymentsCommandCenter apiClientPromise={Promise.resolve({ request })} organizationId="org" />
    );
    await stream.allReady;
    const markup = await new Response(stream).text();

    expect(markup).toContain("Wallet B");
    expect(markup).not.toContain("Wallet A");
    expect(markup).not.toContain("provider-alias");
    expect(markup).toContain("search=unresolved");
    expect(markup).toContain("search=unavailable");
    expect(markup).not.toContain("DashboardPayments.activityKind.transfer · saved-source");
    expect(markup).not.toContain("DashboardPayments.activityKind.deposit · saved-…ient");

    expect(panels).toHaveBeenCalledOnce();
    const { container } = render(
      <activityPanels.PaymentsActivityPanels {...panels.mock.calls[0][0]} />
    );
    fireEvent.click(screen.getByRole("radio", { name: "DashboardPayments.commandCenter.batches" }));
    expect(container.textContent).toContain("DashboardPayments.activityKind.batch");
    expect(container.textContent).not.toContain("Wallet A");
    expect(container.textContent).not.toContain("provider-alias");
    expect(container.textContent).not.toContain(
      "DashboardPayments.activityKind.batch · saved-…urce"
    );
  });
});
