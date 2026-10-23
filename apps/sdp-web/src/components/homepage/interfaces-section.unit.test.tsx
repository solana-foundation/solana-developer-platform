// @vitest-environment jsdom
import { IDEMPOTENCY_REQUIRED_ROUTES } from "@sdp/types/idempotency-required-routes";
import { DEFAULT_SDP_API_URL } from "@sdp/types/site";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { findPublishedPlaygroundOperation } from "@/lib/api-playground-openapi-catalog";
import { setReducedMotion, stubMatchMedia } from "@/test/media-queries";

// jsdom has no AnimationEvent, so React would listen for the prefixed `webkitAnimationEnd`; with
// it defined before React DOM loads, React listens for `animationend` as browsers send it.
vi.hoisted(() => {
  if (!("AnimationEvent" in globalThis)) Object.assign(globalThis, { AnimationEvent: Event });
});

vi.mock("@/i18n/server", async () => {
  const { getMessages } = await import("@/i18n/messages");
  const { translate } = await import("@/i18n/translate");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});

import { InterfacesConsole } from "./interfaces/interfaces-console";
import { INTERFACE_SNIPPETS, lineText, responseRows } from "./interfaces/snippets";
import { InterfacesSection } from "./interfaces-section";

const links = {
  signup: { href: "/sign-up", label: "Create account", external: false },
  signIn: "/sign-in",
  docs: "https://platform.solana.com/docs",
  openapi: "https://platform.solana.com/docs/reference/api",
  llms: "https://platform.solana.com/docs/ai/llms.txt",
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const copy = {
  execute: { title: "Execute mode", body: "Execute body", status: "200 · confirmed" },
  prepare: { title: "Prepare mode", body: "Prepare body", status: "200 · ready to sign" },
  dashboard: { title: "Dashboard", body: "Dashboard body", status: "200 · 1 pending" },
};

function renderConsole() {
  return render(
    <InterfacesConsole copy={copy} modesLabel="Ways in" responseLabel="Response" links={null} />
  );
}

function activeBar() {
  const tab = screen
    .getAllByRole("tab")
    .find((each) => each.getAttribute("aria-selected") === "true");
  const bar = tab?.querySelector<HTMLElement>("[data-state]");
  if (!bar) throw new Error("no active bar");
  return bar;
}

beforeEach(() => {
  stubMatchMedia();
  setReducedMotion(false);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("InterfacesSection", () => {
  it("renders the heading, the ways as tabs, the call as real text and the reference links", async () => {
    const markup = renderToStaticMarkup(await InterfacesSection({ links }));
    const doc = new DOMParser().parseFromString(markup, "text/html");

    const section = doc.querySelector("section#interfaces");
    expect(section?.getAttribute("data-ground")).toBe("paper");
    expect(doc.querySelectorAll("h2")).toHaveLength(1);
    expect(doc.querySelector("h2")?.textContent).toContain("Call the API.");

    const tablist = doc.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("aria-label")).toBe("Ways to work with the platform");
    const tabs = [...doc.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.querySelector("b")?.textContent)).toEqual([
      "Execute mode",
      "Prepare mode",
      "Dashboard",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);

    const panel = doc.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);

    const code = doc.querySelector("pre code")?.textContent ?? "";
    expect(code).toContain(`curl -X POST ${DEFAULT_SDP_API_URL}/v1/payments/transfers`);
    expect(code).toContain('-H "Authorization: Bearer sk_test_…"');

    const anchors = [...doc.querySelectorAll("a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(anchors).toEqual([
      ["OpenAPI", links.openapi],
      ["llms.txt", links.llms],
      ["Docs", links.docs],
    ]);
    // The tabs turn on their own, so the card is not a live region.
    expect(markup).not.toContain("aria-live");
  });
});

describe("interface snippets", () => {
  // The homepage is served on every deployment, so each call must be in prod's public document.
  it.each(INTERFACE_SNIPPETS)("$method $path is a public API route on stable", (snippet) => {
    expect(findPublishedPlaygroundOperation(snippet.method, snippet.path, "stable")).toMatchObject({
      method: snippet.method,
      pathTemplate: snippet.path,
    });
  });

  it.each(INTERFACE_SNIPPETS)("$mode calls its own path on the public host", (snippet) => {
    const concrete = snippet.path
      .split(/\{[^}]+\}/)
      .map(escapeRegExp)
      .join("[^/\\s]+");
    const url = new RegExp(`${escapeRegExp(DEFAULT_SDP_API_URL)}${concrete}`);
    for (const request of [snippet.request, snippet.narrowRequest]) {
      const text = request.map(lineText).join("\n");
      expect(text).toMatch(url);
      expect(text).toContain('Authorization: Bearer sk_test_…"');
      expect(text.startsWith(`$ curl ${snippet.method === "GET" ? "-G" : "-X POST"}`)).toBe(true);
    }
  });

  it.each(INTERFACE_SNIPPETS)("$mode sends a key where the API requires one", (snippet) => {
    const route = (method: string, path: string) =>
      `${method} ${path.replace(/\{[^}]+\}|:[^/]+/g, "*")}`;
    const required = IDEMPOTENCY_REQUIRED_ROUTES.some((each) => {
      const [method, path] = each.split(" ");
      return route(method, path) === route(snippet.method, snippet.path);
    });
    for (const request of [snippet.request, snippet.narrowRequest]) {
      const text = request.map(lineText).join("\n");
      expect(/-H "Idempotency-Key: [^"]+"/.test(text)).toBe(required);
    }
  });

  it("keeps the card one height whichever call it shows", () => {
    for (const pick of [
      (s: (typeof INTERFACE_SNIPPETS)[number]) => s.request,
      (s: (typeof INTERFACE_SNIPPETS)[number]) => s.narrowRequest,
    ]) {
      const heights = INTERFACE_SNIPPETS.map(
        (snippet) =>
          pick(snippet).length +
          Math.max(snippet.response.length, responseRows(INTERFACE_SNIPPETS, pick, snippet))
      );
      expect(new Set(heights).size).toBe(1);
    }
  });
});

describe("InterfacesConsole", () => {
  it("selects a way from the keyboard and holds it", () => {
    renderConsole();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);

    act(() => tabs[0]?.focus());
    fireEvent.keyDown(tabs[0], { key: "ArrowDown" });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[1]?.id);
    expect(screen.getByRole("tabpanel").textContent).toContain("prepare-collection");

    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[2], { key: "ArrowDown" });
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(activeBar().dataset.state).toBe("held");
  });

  it("turns to the next way when the active line has filled", () => {
    renderConsole();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(activeBar().dataset.state).toBe("turning");

    fireEvent.animationEnd(activeBar());
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("does not turn under reduced motion", () => {
    setReducedMotion(true);
    renderConsole();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(activeBar().dataset.state).toBe("held");
    expect(screen.getAllByRole("tab")[0]?.getAttribute("aria-selected")).toBe("true");
  });
});
