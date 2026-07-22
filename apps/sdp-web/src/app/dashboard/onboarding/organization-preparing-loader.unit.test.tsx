import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { OrganizationPreparingLoader } from "./organization-preparing-loader";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("OrganizationPreparingLoader", () => {
  it("keeps provisioning details private and shows an ambient Solana loader", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <OrganizationPreparingLoader />
      </I18nProvider>
    );

    expect(markup).toContain("Your workspace is tying its shoelaces");
    expect(markup).toContain("/landing/solana-logo.svg");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Sparks caught");
    expect(markup).not.toContain("initial organization sync");
    expect(markup).not.toContain("Refresh this page");
  });
});
