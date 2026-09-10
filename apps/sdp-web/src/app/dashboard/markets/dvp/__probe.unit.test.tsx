// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { testTrade } from "./dvp.fixtures";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

it("probe: mounts then rerenders with a changed prop", () => {
  const { rerender } = render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradesWorkspace
        error={null}
        inbound={[]}
        searchQuery="abacus"
        statusFilter="all"
        trades={[testTrade(), testTrade({ id: "dvp_2" })]}
      />
    </I18nProvider>
  );
  console.log("PROBE mounted, value:", (screen.getByRole("searchbox") as HTMLInputElement).value);
  rerender(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DvpTradesWorkspace
        error={null}
        inbound={[]}
        searchQuery="bamboo"
        statusFilter="all"
        trades={[testTrade(), testTrade({ id: "dvp_2" })]}
      />
    </I18nProvider>
  );
  console.log(
    "PROBE rerendered, value:",
    (screen.getByRole("searchbox") as HTMLInputElement).value
  );
});
