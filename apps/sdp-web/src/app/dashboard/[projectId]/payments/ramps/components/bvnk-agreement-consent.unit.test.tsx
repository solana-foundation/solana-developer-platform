// @vitest-environment jsdom

import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { BvnkAgreementConsent } from "./bvnk-agreement-consent";

const agreements: Extract<
  CounterpartyRequirements,
  { status: "counterparty_collect_agreement" }
>["agreements"] = [
  {
    name: "platform_agreement",
    displayName: "Platform Agreement",
    description: "Platform Agreement",
    url: "https://help.bvnk.com/en/articles/platform-agreement",
    privacyPolicyUrl: "https://www.bvnk.com/privacy-policy",
  },
];

function renderConsent(onToggle: (name: string, accepted: boolean) => void) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <BvnkAgreementConsent
        agreements={agreements}
        acceptedAgreements={[]}
        onToggle={onToggle}
        disabled={false}
      />
    </I18nProvider>
  );
}

describe("BvnkAgreementConsent", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders an agreement row and a privacy-policy row per agreement", () => {
    renderConsent(() => {});

    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Platform Agreement" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "privacy policy" })).not.toBeNull();
  });

  it("opens the agreement and privacy-policy links in a new tab", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderConsent(() => {});

    fireEvent.click(screen.getByRole("button", { name: "Platform Agreement" }));
    fireEvent.click(screen.getByRole("button", { name: "privacy policy" }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://help.bvnk.com/en/articles/platform-agreement",
      "_blank",
      "noopener"
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://www.bvnk.com/privacy-policy",
      "_blank",
      "noopener"
    );
  });

  it("reports each checkbox as its own consent key", () => {
    const onToggle = vi.fn();
    renderConsent(onToggle);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    expect(onToggle).toHaveBeenCalledWith("platform_agreement", true);
    expect(onToggle).toHaveBeenCalledWith("platform_agreement:privacy-policy", true);
  });

  it("does not toggle consent when an inline link is clicked", () => {
    const onToggle = vi.fn();
    renderConsent(onToggle);

    fireEvent.click(screen.getByRole("button", { name: "Platform Agreement" }));

    expect(onToggle).not.toHaveBeenCalled();
    const firstCheckbox = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    expect(firstCheckbox.checked).toBe(false);
  });
});
