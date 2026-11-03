// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { leavesApp, MoreLink } from "./more-link";

function linkOf(markup: string) {
  const root = document.createElement("div");
  root.innerHTML = markup;
  const link = root.querySelector("a");
  if (!link) throw new Error("no link");
  return link;
}

describe("MoreLink", () => {
  it("is a plain link with its words and a hidden arrow", () => {
    const link = linkOf(renderToStaticMarkup(<MoreLink href="#issuance">Issue a token</MoreLink>));
    expect(link.getAttribute("href")).toBe("#issuance");
    expect(link.textContent).toBe("Issue a token");
    expect(link.hasAttribute("target")).toBe(false);
    expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens an external target in a new tab", () => {
    const link = linkOf(
      renderToStaticMarkup(
        <MoreLink href="https://waitlist.example.test" external>
          Join the waitlist
        </MoreLink>
      )
    );
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noreferrer");
  });
});

describe("leavesApp", () => {
  it("sends another site and the docs (served under /docs) through a plain link", () => {
    expect(leavesApp("https://docs.example/docs/reference/api")).toBe(true);
    expect(leavesApp("//cdn.example/x")).toBe(true);
    expect(leavesApp("/docs")).toBe(true);
    expect(leavesApp("/docs/ai/llms.txt")).toBe(true);
    expect(leavesApp("mailto:hi@example.test")).toBe(true);
  });

  it("keeps the app's own routes and anchors client-side", () => {
    expect(leavesApp("/sign-up")).toBe(false);
    expect(leavesApp("/docsearch")).toBe(false);
    expect(leavesApp("#issuance")).toBe(false);
  });
});
