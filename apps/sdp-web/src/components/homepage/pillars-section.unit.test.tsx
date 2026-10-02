// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/contexts/theme-context";
import { getMessages, translate } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PillarsSection } from "./pillars-section";
import type { OrigamiOptions } from "./scenes/origami/mount-origami";
import "@/test/match-media";

const scenes = vi.hoisted(() => ({
  mounted: [] as { options: OrigamiOptions; playing: boolean[]; disposed: boolean }[],
}));

vi.mock("motion/react", () => ({
  useInView: () => true,
  useReducedMotion: () => false,
}));

vi.mock("./scenes/origami/load-origami", () => ({
  loadOrigami: async () => ({
    mountOrigami: (_host: HTMLElement, options: OrigamiOptions) => {
      const record = { options, playing: [] as boolean[], disposed: false };
      scenes.mounted.push(record);
      return {
        setPlaying: (playing: boolean) => record.playing.push(playing),
        dispose: () => {
          record.disposed = true;
        },
      };
    },
  }),
}));

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);

beforeEach(() => {
  scenes.mounted = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderPillars() {
  return render(
    <ThemeProvider>
      <I18nProvider locale="en" messages={messages}>
        <PillarsSection t={t} />
      </I18nProvider>
    </ThemeProvider>
  );
}

describe("PillarsSection", () => {
  it("names the section and each pillar, and links each to its product", () => {
    renderPillars();

    expect(
      screen.getByRole("heading", { level: 2, name: "Issue it. Move it. Earn on it." })
    ).toBeTruthy();
    for (const [name, link, href] of [
      ["Issuance", "Issue the asset", "#issuance"],
      ["Payments", "Move the money", "#payments"],
      ["Markets", "Earn on it", "#markets"],
    ]) {
      expect(screen.getByRole("heading", { level: 3, name })).toBeTruthy();
      expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe(href);
    }
  });

  it("mounts each pillar's scene at its own distance, at rest", async () => {
    renderPillars();
    await waitFor(() => expect(scenes.mounted).toHaveLength(3));

    expect(scenes.mounted.map(({ options }) => [options.kind, options.zoom])).toEqual([
      ["coins", 8.2],
      ["loop", 7.6],
      ["balance", 8.4],
    ]);
    expect(scenes.mounted.every(({ playing }) => playing.at(-1) === false)).toBe(true);
  });

  it("moves a scene while the pointer is over its pillar and rests it after", async () => {
    renderPillars();
    await waitFor(() => expect(scenes.mounted).toHaveLength(3));
    vi.useFakeTimers();
    const payments = screen.getByRole("heading", { level: 3, name: "Payments" }).closest("li");

    fireEvent.pointerEnter(payments as HTMLElement);
    expect(scenes.mounted[1].playing.at(-1)).toBe(true);

    fireEvent.pointerLeave(payments as HTMLElement);
    expect(scenes.mounted[1].playing.at(-1)).toBe(true);
    act(() => vi.advanceTimersByTime(1400));
    expect(scenes.mounted[1].playing.at(-1)).toBe(false);
  });

  it("moves a scene while focus is inside its pillar", async () => {
    renderPillars();
    await waitFor(() => expect(scenes.mounted).toHaveLength(3));

    fireEvent.focus(screen.getByRole("link", { name: "Earn on it" }));

    expect(scenes.mounted[2].playing.at(-1)).toBe(true);
  });

  it("disposes every scene on unmount", async () => {
    const { unmount } = renderPillars();
    await waitFor(() => expect(scenes.mounted).toHaveLength(3));

    unmount();

    expect(scenes.mounted.every(({ disposed }) => disposed)).toBe(true);
  });

  it("keeps the scenes out of the accessibility tree", () => {
    const { container } = renderPillars();

    const hosts = container.querySelectorAll("li > div");
    expect(hosts).toHaveLength(3);
    for (const host of hosts) expect(host.getAttribute("aria-hidden")).toBe("true");
  });
});
