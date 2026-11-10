// @vitest-environment jsdom
import { SDP_TERMS } from "@sdp/types/mainnet-access";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import * as mainnetAccess from "./mainnet-access";
import { MainnetAccessRequestHost } from "./mainnet-access-request";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHost() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <MainnetAccessRequestHost
        canRequest
        organizationId="org_sdp"
        organizationName="Acme"
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
      .spyOn(mainnetAccess, "requestMainnetAccess")
      .mockResolvedValue({ ok: false, error: "unused" });
    const user = userEvent.setup();
    renderHost();

    await user.click(screen.getByRole("button", { name: "Request mainnet access…" }));
    const proceed = screen.getByRole("button", { name: "Continue" });
    expect(proceed).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("button", { name: /Country or region/ }));
    await user.type(screen.getByPlaceholderText("Search countries"), "Singa");
    await user.keyboard("{Enter}");
    expect(proceed).toHaveProperty("disabled", false);
    await user.click(proceed);

    const accept = screen.getByRole("checkbox");
    scrollReader("top");
    expect(accept).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Send request" })).toHaveProperty("disabled", true);

    scrollReader("end");
    await waitFor(() => expect(accept).toHaveProperty("disabled", false));
    expect(screen.getByRole("button", { name: "Send request" })).toHaveProperty("disabled", true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each<[mainnetAccess.RequestMainnetAccessResult, string]>([
    [
      {
        ok: true,
        access: {
          state: "pending",
          available: true,
          countryCode: "SG",
          request: null,
          contactEmail: null,
        },
      },
      "Request sent",
    ],
    [{ ok: false, error: "email not sent" }, "Couldn't send your request: email not sent"],
  ])(
    "sends the jurisdiction with the version read, then re-reads the record (%#)",
    async (result, shown) => {
      giveReaderOverflow();
      const request = vi.spyOn(mainnetAccess, "requestMainnetAccess").mockResolvedValue(result);
      const user = userEvent.setup();
      renderHost();

      await user.click(screen.getByRole("button", { name: "Request mainnet access…" }));
      await user.click(screen.getByRole("button", { name: /Country or region/ }));
      await user.type(screen.getByPlaceholderText("Search countries"), "Singa");
      await user.keyboard("{Enter}");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      scrollReader("end");
      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "Send request" }));

      expect(await screen.findByText(shown)).toBeTruthy();
      expect(request).toHaveBeenCalledWith("org_sdp", {
        countryCode: "SG",
        termsVersion: SDP_TERMS.version,
      });
      expect(dashboardRouter.replace).toHaveBeenCalledOnce();
    }
  );
});
