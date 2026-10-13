import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PaymentsCommandCenter } from "./payments-command-center.redesign";

vi.mock("@/lib/sdp-api", () => ({ requestProjectId: async () => "prj_test_sandbox" }));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));
vi.mock("@/flags/ramps", () => ({ getEnabledRampProviders: async () => [] }));
vi.mock("@/lib/provider-availability", () => ({ fetchProviderAvailability: async () => null }));
vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({ step: (_name: string, run: () => unknown) => run(), log: () => {} }),
}));
vi.mock("./payments-activity-panels", () => ({
  PaymentsActivityPanels: ({
    transfers,
    batches,
  }: {
    transfers: React.ReactNode;
    batches: React.ReactNode;
  }) => (
    <>
      {transfers}
      {batches}
    </>
  ),
}));

describe("command center wallet identity", () => {
  it("joins exact pins and keeps the previous labels for unresolved or unavailable wallets", async () => {
    const request = vi.fn(async (path: string) => {
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
    expect(markup).toContain("DashboardPayments.activityKind.batch");
    expect(markup).not.toContain("DashboardPayments.activityKind.transfer · saved-source");
    expect(markup).not.toContain("DashboardPayments.activityKind.deposit · saved-…ient");
    expect(markup).not.toContain("DashboardPayments.activityKind.batch · saved-…urce");
  });
});
