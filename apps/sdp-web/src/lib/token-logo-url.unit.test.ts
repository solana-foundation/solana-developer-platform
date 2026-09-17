import { describe, expect, it } from "vitest";
import { isRenderableLogoUrl } from "./token-logo-url";

describe("isRenderableLogoUrl", () => {
  it.each([
    "https://cdn.example.test/token.png",
    "HTTPS://cdn.example.test/token.png",
    "https://cdn.example.test:8443/a/b/token.png?w=64#frag",
  ])("accepts a credential-free https URL: %s", (url) => {
    expect(isRenderableLogoUrl(url)).toBe(true);
  });

  it.each([
    "http://cdn.example.test/token.png",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "blob:https://example.test/1234",
    "//cdn.example.test/token.png",
    "https://user:pass@cdn.example.test/token.png",
    "https://user@cdn.example.test/token.png",
    "jav\tascript:alert(1)",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(isRenderableLogoUrl(url)).toBe(false);
  });
});
