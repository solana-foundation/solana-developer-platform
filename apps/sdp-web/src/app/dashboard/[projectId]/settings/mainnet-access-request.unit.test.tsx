// @vitest-environment jsdom
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import * as actions from "./mainnet-access-actions";
import { MainnetAccessRequestHost } from "./mainnet-access-request";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHost() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <MainnetAccessRequestHost
        canRequest
        organizationName="Acme"
        termsVersion={SDP_TERMS.version}
        termsUrl={SDP_TERMS.url}
        record={null}
      />
    </I18nProvider>
  );
}

/**
 * jsdom lays nothing out, so every element reads as fitting without a scroll. The reader gets a
 * height taller than its box before it mounts, and is scrolled by hand.
 */
function giveReaderOverflow() {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
}

function scrollReader(to: "top" | "end") {
  const reader = screen.getByRole("document");
  reader.scrollTop = to === "end" ? 700 : 0;
  fireEvent.scroll(reader);
}

describe("MainnetAccessRequestHost", () => {
  it("asks for a jurisdiction, then terms read to the end, before it sends anything", async () => {
    giveReaderOverflow();
    const request = vi
      .spyOn(actions, "requestMainnetAccessAction")
      .mockResolvedValue({ ok: false, error: "unused" });
    const user = userEvent.setup();
    renderHost();

    await user.click(screen.getByRole("button", { name: "Request mainnet access" }));
    const proceed = screen.getByRole("button", { name: "Continue" });
    expect((proceed as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /Country or region/ }));
    await user.type(screen.getByPlaceholderText("Search countries"), "Singa");
    await user.keyboard("{Enter}");
    expect((proceed as HTMLButtonElement).disabled).toBe(false);
    await user.click(proceed);

    const accept = screen.getByRole("checkbox");
    scrollReader("top");
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled
    ).toBe(true);

    scrollReader("end");
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    expect(
      (screen.getByRole("button", { name: "Send request" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("sends the chosen jurisdiction with the version read, and confirms", async () => {
    giveReaderOverflow();
    const request = vi.spyOn(actions, "requestMainnetAccessAction").mockResolvedValue({
      ok: true,
      access: {
        state: "pending",
        countryCode: "SG",
        termsAcceptance: null,
        request: null,
        currentTerms: SDP_TERMS,
        contactEmail: null,
      },
    });
    const user = userEvent.setup();
    renderHost();

    await user.click(screen.getByRole("button", { name: "Request mainnet access" }));
    await user.click(screen.getByRole("button", { name: /Country or region/ }));
    await user.type(screen.getByPlaceholderText("Search countries"), "Singa");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    scrollReader("end");
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(await screen.findByText("Request sent")).toBeTruthy();
    expect(request).toHaveBeenCalledWith({ countryCode: "SG", termsVersion: SDP_TERMS.version });
  });
});
