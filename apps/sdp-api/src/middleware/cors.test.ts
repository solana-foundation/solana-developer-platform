import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { corsMiddleware, createOriginMatcher } from "./cors";

describe("createOriginMatcher", () => {
  it("allows an exact origin", () => {
    const matches = createOriginMatcher(["https://solana.com"], []);
    expect(matches("https://solana.com")).toBe(true);
  });

  it("does not treat exact origins as regular expressions", () => {
    const matches = createOriginMatcher(["https://solana.com"], []);
    expect(matches("https://solanaXcom")).toBe(false);
  });

  it("allows a single-label wildcard subdomain", () => {
    const matches = createOriginMatcher([], ["https://*.vercel.app"]);
    expect(matches("https://preview-git-main-team.vercel.app")).toBe(true);
  });

  it("rejects a look-alike domain abusing the unescaped dot", () => {
    const matches = createOriginMatcher([], ["https://*.vercel.app"]);
    expect(matches("https://evil-vercel.app")).toBe(false);
  });

  it("rejects a domain that merely suffixes the wildcard host", () => {
    const matches = createOriginMatcher([], ["https://*.vercel.app"]);
    expect(matches("https://vercel.app.evil.com")).toBe(false);
  });

  it("rejects nested subdomains for a single-label wildcard", () => {
    const matches = createOriginMatcher([], ["https://*.vercel.app"]);
    expect(matches("https://a.b.vercel.app")).toBe(false);
  });
});

describe("corsMiddleware", () => {
  function buildApp(environment: "production" | "development") {
    const app = new Hono();
    app.use("*", corsMiddleware(environment));
    app.all("*", (c) => c.json({ ok: true }));
    return app;
  }

  it("echoes an allowed production origin", async () => {
    const app = buildApp("production");
    const res = await app.request("/x", { headers: { Origin: "https://solana.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://solana.com");
  });

  it("rejects a disallowed production origin", async () => {
    const app = buildApp("production");
    const res = await app.request("/x", { headers: { Origin: "https://evil.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a wildcard look-alike origin in production", async () => {
    const app = buildApp("production");
    const res = await app.request("/x", { headers: { Origin: "https://evil-vercel.app" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows a localhost dev origin in development", async () => {
    const app = buildApp("development");
    const res = await app.request("/x", { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("allows a vercel preview origin in development", async () => {
    const app = buildApp("development");
    const res = await app.request("/x", {
      headers: { Origin: "https://sdp-web-smoky.vercel.app" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://sdp-web-smoky.vercel.app");
  });

  it("rejects an unlisted origin in development instead of reflecting it", async () => {
    const app = buildApp("development");
    const res = await app.request("/x", { headers: { Origin: "https://anything.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a cross-origin credentialed preflight to a money route in development", async () => {
    const app = buildApp("development");
    const res = await app.request("/v1/earn/vault-withdrawals", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    // Without Access-Control-Allow-Origin the browser fails the preflight, so
    // the credentialed cross-origin POST never leaves the preflight stage.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("passes a credentialed preflight from an allowed origin in development", async () => {
    const app = buildApp("development");
    const res = await app.request("/v1/earn/vault-withdrawals", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
