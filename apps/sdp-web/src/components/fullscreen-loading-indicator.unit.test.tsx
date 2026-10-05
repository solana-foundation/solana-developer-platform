// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { FullscreenLoadingIndicator } from "./fullscreen-loading-indicator";

function renderIndicator(newDesign: boolean) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <FullscreenLoadingIndicator newDesign={newDesign}>
        <div />
      </FullscreenLoadingIndicator>
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("FullscreenLoadingIndicator", () => {
  it("paints NEW DESIGN's ruled 280px sidebar and flat page, marked for its palette", () => {
    const { container } = renderIndicator(true);
    const main = container.querySelector("main");
    expect(main?.hasAttribute("data-sdp-new-design")).toBe(true);
    expect(container.querySelector('[style*="width: 280px"]')?.className).toContain("border-r");
    expect(container.querySelector("section")?.className).not.toContain("rounded-2xl");
  });

  it("keeps the previous design's 296px sidebar and rounded page card", () => {
    const { container } = renderIndicator(false);
    expect(container.querySelector("main")?.hasAttribute("data-sdp-new-design")).toBe(false);
    expect(container.querySelector('[style*="width: 296px"]')?.className).not.toContain("border-r");
    expect(container.querySelector("section")?.className).toContain("rounded-2xl");
  });
});
