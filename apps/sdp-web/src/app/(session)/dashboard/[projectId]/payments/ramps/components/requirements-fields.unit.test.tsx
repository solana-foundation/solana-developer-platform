// @vitest-environment jsdom

import type { RequirementField } from "@sdp/types/ramp-requirements";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { RequirementsFields } from "./requirements-fields";

const TERMS = {
  kind: "consent",
  key: "acceptHercleTerms",
  label: "I declare that I have read and accepted Hercle's",
  documentLabel: "Terms & Conditions",
  documentUrl: "https://hercle.com/terms/",
  required: true,
} as const satisfies RequirementField;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("RequirementsFields consent", () => {
  it("ticks to the literal true and clears to empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <RequirementsFields fields={[TERMS]} values={{}} onChange={onChange} />,
      { wrapper }
    );

    await user.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith("acceptHercleTerms", "true");

    rerender(
      <RequirementsFields
        fields={[TERMS]}
        values={{ acceptHercleTerms: "true" }}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith("acceptHercleTerms", "");
  });

  it("links the document being accepted from inside the sentence, in a new tab", () => {
    render(<RequirementsFields fields={[TERMS]} values={{}} onChange={vi.fn()} />, { wrapper });

    const link = screen.getByRole("link", { name: /Terms & Conditions/ });
    expect(link.getAttribute("href")).toBe("https://hercle.com/terms/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });
});
