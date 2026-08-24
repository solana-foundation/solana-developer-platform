// @vitest-environment jsdom

import type { EarnStrategy, SdpEnvironment } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnButtonBuilder } from "./earn-button-builder";

const liveStrategy: EarnStrategy = {
  id: "earn_strategy_live",
  provider: "kamino",
  providerReference: "Kvault11111111111111111111111111111111111",
  name: "Kamino USDC Vault",
  sourceKind: "defi",
  depositMints: ["So11111111111111111111111111111111111111112"],
  shareMint: "Share1111111111111111111111111111111111111",
  apyType: "variable",
  currentApy: "0.062",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "devnet",
  fundable: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const mocks = vi.hoisted(() => ({ environment: "sandbox" as SdpEnvironment }));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("./earn-program-data", () => ({
  useEarnStrategies: () => ({ strategies: [liveStrategy], error: undefined, isLoading: false }),
}));

vi.mock("@/components/ui/code-block", () => ({
  CodeBlock: ({ code, title }: { code: string; title?: ReactNode }) => (
    <figure>
      <figcaption>{title}</figcaption>
      <pre>{code}</pre>
    </figure>
  ),
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function previewFigure(label: string): HTMLElement {
  const figure = screen.getByText(label).closest("figure");
  if (!figure) throw new Error(`Could not find the ${label} figure`);
  return figure;
}

afterEach(() => {
  mocks.environment = "sandbox";
  cleanup();
});

describe("EarnButtonBuilder", () => {
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  } as const;

  it("shows a disabled visual preview and emits the real header-idempotent server contract", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        earnHref="/dashboard/markets/earn"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    const iosPreview = previewFigure("iOS preview");
    const webPreview = previewFigure("Web browser preview");
    expect(within(iosPreview).getByText("Kamino USDC Vault")).toBeTruthy();
    expect(within(webPreview).getByText("6.2% variable APY")).toBeTruthy();

    const accentRadio = screen.getByRole("radio", { name: /^Accent/ }) as HTMLInputElement;
    expect(accentRadio.disabled).toBe(true);
    expect(accentRadio.checked).toBe(false);
    expect(
      screen.getByText(/Button style export and persistence are not available yet/)
    ).toBeTruthy();
    for (const preview of [iosPreview, webPreview]) {
      expect(within(preview).getByText("Deposit & earn").className).toContain("bg-primary");
    }

    const code = screen.getByText(/v1\/earn\/vault-deposits/).textContent ?? "";
    expect(code).toContain('"Idempotency-Key": idempotencyKey');
    expect(code).not.toContain("crypto.randomUUID()");
    expect(code).toContain('strategyId: "earn_strategy_live"');
    expect(code).toContain("response.status === 202");
    expect(code).not.toContain("requestId");
    expect(code).not.toContain("developers.solana.com/earn/buttons");
    expect(screen.getByRole("link", { name: "Done" }).getAttribute("href")).toBe(
      "/dashboard/markets/earn"
    );
  });

  it("offers a recovery route when the live strategy id no longer resolves", () => {
    renderWithEnglish(
      <EarnButtonBuilder earnHref="/dashboard/markets/earn" providerAccess={providerAccess} />
    );

    expect(screen.getByText("Choose a strategy first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Return to Earn" }).getAttribute("href")).toBe(
      "/dashboard/markets/earn"
    );
    expect(screen.queryByText("iOS preview")).toBeNull();
  });

  it("refuses a deep link when the selected environment cannot fund the strategy", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnButtonBuilder
        earnHref="/dashboard/markets/earn"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.queryByText("Server integration")).toBeNull();
  });
});
