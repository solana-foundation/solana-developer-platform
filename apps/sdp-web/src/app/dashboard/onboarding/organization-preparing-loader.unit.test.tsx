import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OrganizationPreparingLoader } from "./organization-preparing-loader";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("OrganizationPreparingLoader", () => {
  it("keeps provisioning details private and offers a playful wait state", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <OrganizationPreparingLoader />
      </I18nProvider>
    );

    expect(markup).toContain("Your workspace is tying its shoelaces");
    expect(markup).toContain("Catch the moving spark");
    expect(markup).toContain("Sparks caught: 0");
    expect(markup).not.toContain("sync");
    expect(markup).not.toContain("Refresh this page");
  });
});
