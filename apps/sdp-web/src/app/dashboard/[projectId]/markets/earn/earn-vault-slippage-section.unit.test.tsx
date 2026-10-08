// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { VaultSlippageSection } from "./earn-vault-slippage-section";

function SlippageDisclosure() {
  const [open, setOpen] = useState(false);

  return (
    <VaultSlippageSection
      help="The withdrawal refuses to execute below this floor."
      idPrefix="test"
      input="10"
      invalid={false}
      onChange={() => undefined}
      onToggle={() => setOpen((current) => !current)}
      open={open}
      submitting={false}
      toleranceBps={10}
    />
  );
}

describe("VaultSlippageSection", () => {
  it("uses the full-width summary-card disclosure pattern", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <SlippageDisclosure />
      </I18nProvider>
    );

    const trigger = screen.getByRole("button", {
      name: "Slippage tolerance. Up to 0.1% less than quoted",
    });
    expect(trigger.className).toContain("w-full");
    expect(trigger.closest("section")?.className).toContain("rounded-2xl");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Slippage tolerance (basis points)")).toBeTruthy();
    expect(screen.getByText("The withdrawal refuses to execute below this floor.")).toBeTruthy();
  });
});
