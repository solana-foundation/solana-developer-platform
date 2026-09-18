import { describe, expect, it } from "vitest";
import { isLinkPreviewRequest } from "./link-preview";

describe("link preview requests", () => {
  it("lets known unfurlers read the page shell", () => {
    for (const userAgent of [
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "facebookexternalhit/1.1 Facebot Twitterbot/1.0",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    ]) {
      expect(
        isLinkPreviewRequest({ method: "GET", pathname: "/", userAgent })
      ).toBe(true);
    }
  });

  it("never opens anything but the root page shell", () => {
    const userAgent = "Slackbot-LinkExpanding 1.0";
    expect(
      isLinkPreviewRequest({
        method: "GET",
        pathname: "/api/dashboard",
        userAgent,
      })
    ).toBe(false);
    expect(
      isLinkPreviewRequest({ method: "POST", pathname: "/", userAgent })
    ).toBe(false);
    expect(
      isLinkPreviewRequest({
        method: "GET",
        pathname: "/",
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0",
      })
    ).toBe(false);
    expect(
      isLinkPreviewRequest({ method: "GET", pathname: "/", userAgent: null })
    ).toBe(false);
  });
});
