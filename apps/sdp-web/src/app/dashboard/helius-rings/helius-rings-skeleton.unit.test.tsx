import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MembersLoading from "../members/loading";
import { HeliusRingsWorkspaceSkeleton } from "./helius-rings-skeleton";
import HeliusRingsLoading from "./loading";

const SECTIONS = ["health", "rings", "wallets", "overview", "composer", "activity"];

describe("Helius Rings loading state", () => {
  it("paints its own layout instead of inheriting the Home skeleton", () => {
    const markup = renderToStaticMarkup(<HeliusRingsLoading />);

    expect(markup).toContain('data-loading-layout="helius-rings"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('data-loading-layout="home"');
  });

  it("draws every section of the settled workspace, banner first", () => {
    const markup = renderToStaticMarkup(<HeliusRingsLoading />);

    const order = ["devnet-banner", ...SECTIONS].map((section) =>
      markup.indexOf(`data-loading-section="${section}"`)
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps the rows the tables settle into", () => {
    const markup = renderToStaticMarkup(<HeliusRingsLoading />);

    expect(markup.match(/data-loading-row="wallet"/g)).toHaveLength(2);
    expect(markup.match(/data-loading-row="activity"/g)).toHaveLength(3);
  });

  it("uses the page's own frame so the skeleton sits where the workspace will", () => {
    const markup = renderToStaticMarkup(<HeliusRingsLoading />);

    expect(markup).toContain("mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8");
    expect(markup).toContain("lg:grid-cols-2");
  });

  it("leaves the banner and page frame to the workspace when it reuses the body", () => {
    const markup = renderToStaticMarkup(<HeliusRingsWorkspaceSkeleton />);

    expect(markup).not.toContain('data-loading-section="devnet-banner"');
    expect(markup).not.toContain("px-6 py-8");
    for (const section of SECTIONS) {
      expect(markup).toContain(`data-loading-section="${section}"`);
    }
  });

  it("stops every pulse when reduced motion is requested", () => {
    const pulses = [
      ...renderToStaticMarkup(<HeliusRingsLoading />).matchAll(
        /class="([^"]*animate-pulse[^"]*)"/g
      ),
    ].map((match) => match[1] ?? "");

    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses.every((className) => className.includes("motion-reduce:animate-none"))).toBe(
      true
    );
  });
});

describe("Members loading state", () => {
  it("loads as Settings, the page it redirects to", () => {
    const markup = renderToStaticMarkup(<MembersLoading />);

    expect(markup).toContain('data-loading-layout="settings"');
    expect(markup).not.toContain('data-loading-layout="home"');
  });
});
