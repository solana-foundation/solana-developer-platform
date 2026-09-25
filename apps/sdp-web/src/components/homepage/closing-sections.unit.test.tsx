// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { BuildersSection } from "./builders-section";
import { DoorSection } from "./door-section";
import { HomeFooter } from "./home-footer";
import { InterfacesSection } from "./interfaces-section";
import { WalkthroughsSection } from "./walkthroughs-section";

const builders = vi.hoisted(() => ({ webgl: true, mounted: 0 }));

vi.mock("motion/react", () => ({
  useInView: () => true,
  useReducedMotion: () => false,
}));

vi.mock("./scenes/builders/load-builders", () => ({
  loadBuilders: async () => ({
    mountBuilders: () => {
      builders.mounted += 1;
      return builders.webgl ? () => {} : null;
    },
  }),
}));

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);
const hrefs = {
  docs: "https://docs.test/docs",
  llms: "https://docs.test/docs/ai/llms.txt",
  openApi: "https://api.test/openapi.json",
  github: "https://github.test/sdp",
};

afterEach(() => {
  cleanup();
  builders.webgl = true;
  builders.mounted = 0;
});

function inI18n(children: React.ReactNode) {
  return render(
    <I18nProvider locale="en" messages={messages}>
      {children}
    </I18nProvider>
  );
}

describe("InterfacesSection", () => {
  it("shows a real call against the public contract", () => {
    inI18n(<InterfacesSection t={t} hrefs={hrefs} />);

    const code = screen.getByText(/curl -X POST/);
    expect(code.textContent).toContain("/v1/payments/transfers");
    expect(code.textContent).toContain('"status": "confirmed"');
  });

  it("links the references, saying which open a new tab", () => {
    inI18n(<InterfacesSection t={t} hrefs={hrefs} />);

    expect(
      screen.getByRole("link", { name: /OpenAPI\s+\(opens in a new tab\)/ }).getAttribute("href")
    ).toBe(hrefs.openApi);
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(hrefs.docs);
  });
});

describe("BuildersSection", () => {
  it("names the section and links the series", () => {
    inI18n(<BuildersSection />);

    expect(screen.getByRole("region", { name: "Meet the builders" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Watch the series\s+\(opens in a new tab\)/ })
        .getAttribute("target")
    ).toBe("_blank");
  });

  it("links every interview by name, so the films are reachable without a pointer", () => {
    inI18n(<BuildersSection />);

    const films = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("https://www.youtube.com/watch?v="));
    expect(films).toHaveLength(16);
    expect(
      screen.getByRole("link", { name: /^Fireblocks\s+\(opens in a new tab\)$/ })
    ).toBeTruthy();
  });

  it("pins the shot once the ring is mounted", async () => {
    const { container } = inI18n(<BuildersSection />);
    const section = container.querySelector("#builders");
    expect(section?.getAttribute("data-mode")).toBe("plain");

    await waitFor(() => expect(section?.getAttribute("data-mode")).toBe("shot"));
    expect(builders.mounted).toBe(1);
  });

  it("stays plain without WebGL", async () => {
    builders.webgl = false;
    const { container } = inI18n(<BuildersSection />);

    await waitFor(() => expect(builders.mounted).toBe(1));
    expect(container.querySelector("#builders")?.getAttribute("data-mode")).toBe("plain");
  });
});

describe("WalkthroughsSection", () => {
  it("loads the chosen chapter's film with its captions", () => {
    const { container } = inI18n(<WalkthroughsSection t={t} />);
    const chapters = screen.getByRole("group", { name: "Chapters" });
    const first = within(chapters).getByRole("button", { name: /Delivery versus payment/ });
    const second = within(chapters).getByRole("button", { name: /What changed in v1.0/ });

    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "/homepage/video/dvp-demo.mp4"
    );

    fireEvent.click(second);

    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "/homepage/video/v1-changes.mp4"
    );
    expect(container.querySelector("track")?.getAttribute("src")).toBe(
      "/homepage/video/v1-changes.vtt"
    );
  });
});

describe("DoorSection and HomeFooter", () => {
  it("opens the sandbox from the door", () => {
    inI18n(
      <DoorSection t={t} sandbox={{ href: "/sign-up", label: "Homepage.nav.createAccount" }} />
    );

    expect(screen.getByRole("link", { name: /Open the sandbox/ }).getAttribute("href")).toBe(
      "/sign-up"
    );
  });

  it("is the page's contentinfo, with three labelled link groups", () => {
    inI18n(<HomeFooter t={t} hrefs={hrefs} />);

    const footer = screen.getByRole("contentinfo");
    for (const name of ["Platform", "Developers", "Ecosystem"]) {
      expect(within(footer).getByRole("navigation", { name })).toBeTruthy();
    }
    expect(
      within(footer)
        .getByRole("link", { name: /GitHub/ })
        .getAttribute("href")
    ).toBe(hrefs.github);
  });
});
