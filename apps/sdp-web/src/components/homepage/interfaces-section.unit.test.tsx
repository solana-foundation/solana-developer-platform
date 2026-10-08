// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SDP_API_URL } from "@sdp/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

const motion = vi.hoisted(() => ({ reduced: false }));

// jsdom has no AnimationEvent, so React would listen for the prefixed `webkitAnimationEnd`; with
// it defined before React DOM loads, React listens for `animationend` as browsers send it.
vi.hoisted(() => {
  if (!("AnimationEvent" in globalThis)) Object.assign(globalThis, { AnimationEvent: Event });
});

vi.mock("@/i18n/server", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    getTranslations: async () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("@/i18n/provider", async () => {
  const { getMessages, translate } = await import("@/i18n/messages");
  return {
    useLocale: () => "en",
    useTranslations: () => (key: MessageKey, values?: TranslationValues) =>
      translate(getMessages("en"), key, values),
  };
});
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

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
  motion.reduced = false;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  const pathsDirectory = path.resolve(__dirname, "../../../../sdp-api/src/openapi/paths");
  const hidden = new Set([
    "admin.ts",
    "earn.ts",
    "earn-treasury.ts",
    "members.ts",
    "onboarding.ts",
    "organizations.ts",
    "rpc.ts",
  ]);
  const publicSource = readdirSync(pathsDirectory)
    .filter((file) => file.endsWith(".ts") && !hidden.has(file))
    .map((file) => readFileSync(path.join(pathsDirectory, file), "utf8"))
    .join("\n");

  it.each(INTERFACE_SNIPPETS)("$method $path is a public API route", (snippet) => {
    expect(publicSource).toMatch(
      new RegExp(`method: "${snippet.method.toLowerCase()}",\\s*path: "${snippet.path}"`)
    );
  });

  it.each(INTERFACE_SNIPPETS)("$mode calls its own path on the public host", (snippet) => {
    const concrete = snippet.path.replace(/\{[^}]+\}/g, "[^/\\s]+").replace(/\//g, "\\/");
    const url = new RegExp(`${DEFAULT_SDP_API_URL.replace(/\./g, "\\.")}${concrete}`);
    for (const request of [snippet.request, snippet.narrowRequest]) {
      const text = request.map(lineText).join("\n");
      expect(text).toMatch(url);
      expect(text).toContain('Authorization: Bearer sk_test_…"');
      expect(text.startsWith(`$ curl ${snippet.method === "GET" ? "-G" : "-X POST"}`)).toBe(true);
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
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowDown" });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[1]?.id);
    expect(screen.getByRole("tabpanel").textContent).toContain("prepare-collection");

    fireEvent.keyDown(tabs[1] as HTMLElement, { key: "End" });
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[2] as HTMLElement, { key: "ArrowDown" });
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
    motion.reduced = true;
    renderConsole();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(activeBar().dataset.state).toBe("held");
    expect(screen.getAllByRole("tab")[0]?.getAttribute("aria-selected")).toBe("true");
  });
});
