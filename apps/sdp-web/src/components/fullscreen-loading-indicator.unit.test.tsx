// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { FullscreenLoadingIndicator } from "./fullscreen-loading-indicator";

function renderIndicator() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <FullscreenLoadingIndicator>
        <div />
      </FullscreenLoadingIndicator>
    </I18nProvider>
  );
}

afterEach(cleanup);

describe("FullscreenLoadingIndicator", () => {
  it("paints the ruled 280px sidebar and flat page, marked for the refresh palette", () => {
    const { container } = renderIndicator();
    const main = container.querySelector("main");
    expect(main?.hasAttribute("data-sdp-dashboard-shell")).toBe(true);
    expect(container.querySelector('[style*="width: 280px"]')?.className).toContain("border-r");
  });
});
