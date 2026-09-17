// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { BuyerContactFields } from "./buyer-contact-fields";

function renderFields(email: string, phone: string) {
  const onEmailChange = vi.fn();
  const onPhoneChange = vi.fn();
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <BuyerContactFields
        email={email}
        phone={phone}
        onEmailChange={onEmailChange}
        onPhoneChange={onPhoneChange}
      />
    </I18nProvider>
  );
  return { onEmailChange, onPhoneChange };
}

afterEach(cleanup);

describe("BuyerContactFields", () => {
  it("stays quiet until the buyer has typed something", () => {
    renderFields("", "");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Buyer email").getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByLabelText("Buyer phone").getAttribute("aria-invalid")).toBe("false");
  });

  it("names the field that is wrong once it has a value", () => {
    renderFields("not-an-email", "+1 555 123 4567");

    expect(screen.getByText("Enter the buyer's email address.")).not.toBeNull();
    expect(screen.queryByText("Enter the buyer's phone number.")).toBeNull();
    const email = screen.getByLabelText("Buyer email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe("coinbase-buyer-email-error");
  });

  it("accepts the punctuation the provider strips before sending", () => {
    renderFields("buyer@example.com", "+1 (555) 123-4567");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports edits back to the wizard", () => {
    const { onEmailChange } = renderFields("", "");

    fireEvent.change(screen.getByLabelText("Buyer email"), {
      target: { value: "buyer@example.com" },
    });

    expect(onEmailChange).toHaveBeenCalledWith("buyer@example.com");
  });
});
