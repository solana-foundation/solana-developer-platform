// @vitest-environment jsdom

import type { EarnStrategy } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnProgramWorkspace } from "./earn-program-workspace";

const mocks = vi.hoisted(() => ({
  environment: "sandbox" as "sandbox" | "production",
  push: vi.fn(),
}));

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("./earn-program-data", () => ({
  useEarnStrategies: () => ({ strategies: [liveStrategy], error: undefined, isLoading: false }),
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.environment = "sandbox";
  mocks.push.mockClear();
});

afterEach(cleanup);

describe("EarnProgramWorkspace", () => {
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  } as const;

  it("selects a live provider strategy and routes its canonical id to the builder", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnProgramWorkspace
        builderHref="/dashboard/markets/earn/button-builder"
        providerAccess={providerAccess}
      />
    );

    const row = screen.getByText("Kamino USDC Vault").closest("tr");
    if (!row) throw new Error("Expected the live strategy row");
    expect(row.textContent).toContain("6.2%");
    expect(row.textContent).toContain("Sandbox ready");

    await user.click(within(row).getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Continue to integration" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/dashboard/markets/earn/button-builder?strategy=earn_strategy_live"
    );
    expect(document.body.textContent).not.toContain("Mock");
  });

  it("does not offer a production deposit flow before vault withdrawals exist", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnProgramWorkspace
        builderHref="/dashboard/markets/earn/button-builder"
        providerAccess={providerAccess}
      />
    );

    expect(screen.getByText("Sandbox only")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Select" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(document.body.textContent).toContain("intentionally closed in production");
  });

  it("fails closed when the organization provider is not enabled", () => {
    renderWithEnglish(
      <EarnProgramWorkspace
        builderHref="/dashboard/markets/earn/button-builder"
        providerAccess={{
          kamino: { entitled: false, configured: true, enabled: false },
        }}
      />
    );

    expect(screen.getByText("Setup required")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Select" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
