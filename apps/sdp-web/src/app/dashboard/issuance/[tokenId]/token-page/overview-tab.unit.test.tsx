// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: "development" }),
}));

const { DeployProgressBlock } = await import("./overview-tab");

const messages = getMessages("en");
const overview = messages.DashboardIssuance.newDesign.overview;

describe("DeployProgressBlock", () => {
  afterEach(cleanup);

  it("shows every step under way while the deploy is pending, none left waiting at signing", () => {
    render(
      <I18nProvider locale="en" messages={messages}>
        <DeployProgressBlock signingWalletName="Treasury" />
      </I18nProvider>
    );

    const steps = screen.getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      overview.deployStepSign.replace("{wallet}", "Treasury"),
      overview.deployStepSend.replace("{network}", overview.networkDevnet),
      overview.deployStepConfirm,
    ]);
    // The API records a deploy only as pending until it lands, so no one step is singled out.
    for (const step of steps) {
      expect(step.getAttribute("aria-current")).toBeNull();
      expect(step.querySelector("span[aria-hidden]")?.className).toContain("bg-info");
      expect(step.lastElementChild?.className).toContain("text-primary");
    }
  });
});
