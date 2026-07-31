// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/payments/private-channels/transfer",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@solana/design-system/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tab: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

import { PrivateChannelsHeaderTabs } from "./private-channels-header-tabs";

afterEach(cleanup);

describe("PrivateChannelsHeaderTabs", () => {
  it("places Transfer between Deposit and Withdraw for connected instances", () => {
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrivateChannelsHeaderTabs isConnected />
      </I18nProvider>
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Overview",
      "Channels",
      "Deposit",
      "Transfer",
      "Withdraw",
      "Members",
      "Events",
      "Instance",
    ]);
  });
});
