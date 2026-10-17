// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

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

import { formatDuration } from "./walkthroughs/films";
import { WalkthroughsPlayer } from "./walkthroughs/walkthroughs-player";
import { WalkthroughsSection } from "./walkthroughs-section";

const media = {
  play: vi.fn(() => Promise.resolve()),
  load: vi.fn(),
  tracks: [] as { mode: string }[],
};

beforeEach(() => {
  media.play.mockClear();
  media.load.mockClear();
  media.tracks = [{ mode: "disabled" }];
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(media.play);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(media.load);
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockReturnValue(true);
  Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
    configurable: true,
    get: () => media.tracks,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WalkthroughsSection", () => {
  it("keeps its anchor on a night ground, under one h2", async () => {
    const markup = renderToStaticMarkup(await WalkthroughsSection());
    expect(markup).toMatch(/^<section id="blog" data-ground="night"/);
    expect(markup.match(/<h2/g)).toHaveLength(1);
    expect(markup).toContain("The sandbox walkthroughs.");
  });

  it("loads nothing until asked, with the poster and a caption track", async () => {
    const markup = renderToStaticMarkup(await WalkthroughsSection());
    expect(markup).toContain('preload="none"');
    expect(markup).toContain('poster="/homepage/posters/dvp.jpg"');
    expect(markup).toContain('src="/homepage/video/dvp-demo.mp4"');
    expect(markup).not.toContain("autoPlay");
    expect(markup).not.toMatch(/autoplay/i);
    // the DvP film burns its captions in: the track is there but not on by default
    expect(markup).toMatch(
      /<track kind="captions" srcLang="en" label="English" src="\/homepage\/video\/dvp-demo.vtt"\/>/
    );
    // before hydration the native controls are the way in
    expect(markup).toMatch(/<video[^>]*controls=""/);
  });
});

describe("WalkthroughsPlayer", () => {
  function chapters() {
    const list = screen.getByRole("list", { name: "Chapters" });
    return Array.from(list.querySelectorAll("button"));
  }

  it("lists the films as buttons, the first one current", () => {
    render(<WalkthroughsPlayer />);
    const [dvp, v1] = chapters();
    expect(dvp?.getAttribute("aria-current")).toBe("true");
    expect(v1?.getAttribute("aria-current")).toBe("false");
    expect(dvp?.textContent).toContain("Delivery versus payment");
    expect(v1?.textContent).toContain("What changed in v1.0");
    expect(
      screen.getByRole("button", { name: "Watch “Delivery versus payment”, 28 seconds" })
    ).toBeTruthy();
  });

  it("swaps the film from the list, captions on, and leaves focus on the row pressed", () => {
    const { container } = render(<WalkthroughsPlayer />);
    const [dvp, v1] = chapters();
    if (!dvp || !v1) throw new Error("missing chapters");
    v1.focus();
    fireEvent.click(v1);

    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/homepage/video/v1-changes.mp4");
    expect(video?.getAttribute("poster")).toBe("/homepage/posters/v1.jpg");
    const track = container.querySelector("track");
    expect(track?.getAttribute("src")).toBe("/homepage/video/v1-changes.vtt");
    expect(track?.hasAttribute("default")).toBe(true);
    expect(media.tracks[0]?.mode).toBe("showing");
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(v1?.getAttribute("aria-current")).toBe("true");
    expect(dvp?.getAttribute("aria-current")).toBe("false");
    expect(document.activeElement).toBe(v1);
    expect(screen.getByRole("button", { name: /^Watch “What changed in v1\.0”/ })).toBeTruthy();
  });

  it("plays the current film again without reloading it", () => {
    render(<WalkthroughsPlayer />);
    const [dvp] = chapters();
    if (!dvp) throw new Error("missing chapters");
    fireEvent.click(dvp);
    expect(media.load).not.toHaveBeenCalled();
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("hands focus to the video on Watch, and back to Watch when the film ends", () => {
    const { container } = render(<WalkthroughsPlayer />);
    const video = container.querySelector("video");
    if (!video) throw new Error("missing video");
    // hydrated: the controls wait for the film
    expect(video?.hasAttribute("controls")).toBe(false);

    const watch = screen.getByRole("button", { name: /^Watch/ });
    fireEvent.click(watch);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(document.activeElement).toBe(video);

    act(() => {
      video.dispatchEvent(new Event("play"));
    });
    expect(container.firstElementChild?.getAttribute("data-playing")).toBe("true");

    act(() => {
      video.dispatchEvent(new Event("ended"));
    });
    expect(container.firstElementChild?.getAttribute("data-playing")).toBe("false");
    expect(video?.hasAttribute("controls")).toBe(false);
    expect(document.activeElement).toBe(watch);
  });
});

describe("WalkthroughsPlayer refusals", () => {
  it("shows the native controls when the browser refuses to play", async () => {
    media.play.mockImplementationOnce(() =>
      Promise.reject(new DOMException("needs a gesture", "NotAllowedError"))
    );
    const { container } = render(<WalkthroughsPlayer />);
    const video = container.querySelector("video");
    const [, v1] = Array.from(
      screen.getByRole("list", { name: "Chapters" }).querySelectorAll("button")
    );
    if (!video || !v1) throw new Error("missing player");
    expect(video.hasAttribute("controls")).toBe(false);

    await act(async () => {
      fireEvent.click(v1);
    });
    expect(video.hasAttribute("controls")).toBe(true);
  });

  it("ignores a start cut short by the next film's load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    media.play.mockImplementationOnce(() =>
      Promise.reject(new DOMException("interrupted", "AbortError"))
    );
    render(<WalkthroughsPlayer />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Watch/ }));
    });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("formatDuration", () => {
  it("prints minutes and padded seconds", () => {
    expect(formatDuration(28)).toBe("0:28");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(-3)).toBe("0:00");
  });
});
