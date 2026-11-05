import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

describe("Docs proxy rewrites", () => {
  it.each([
    ["/llms.txt", "/docs/ai/llms.txt"],
    ["/llms-full.txt", "/docs/ai/llms-full.txt"],
    ["/SKILL.md", "/SKILL.md"],
    ["/docs.md", "/docs.md"],
  ])("serves %s from the docs app's %s", async (source, docsPath) => {
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toContainEqual({
      source,
      destination: expect.stringMatching(new RegExp(`^https?://[^/]+${docsPath}$`)),
    });
  });
});
