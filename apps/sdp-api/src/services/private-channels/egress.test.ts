import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertApprovedPrivateChannelDestinations,
  buildPrivateChannelEgressAllowlist,
  checkPrivateChannelDestination,
  createPrivateChannelProbeTransport,
  resolvePrivateChannelEgressAllowlist,
} from "@/services/private-channels/egress";
import type { Env } from "@/types/env";

/**
 * The gateway and auth URLs are project input, so these are the bypass cases:
 * every way of writing a destination that reads as approved and resolves
 * somewhere else. The other half — what a name resolves to at connect time —
 * belongs to the transport and is covered in `services/guarded-egress.test.ts`.
 */

const ALLOWED = "https://gateway.private-channels.test";
const allowlist = buildPrivateChannelEgressAllowlist([ALLOWED, "http://10.0.0.7:8899"]);

function check(raw: string) {
  return checkPrivateChannelDestination(raw, allowlist, "gatewayUrl");
}

function envWith(setting?: string): Env {
  return { PRIVATE_CHANNEL_EGRESS_ALLOWLIST: setting } as Env;
}

describe("checkPrivateChannelDestination", () => {
  it("approves the exact origin that was configured", () => {
    const result = check(`${ALLOWED}/health`);

    expect(result.ok).toBe(true);
  });

  it("approves the configured origin on any path", () => {
    expect(check(`${ALLOWED}/ready`).ok).toBe(true);
    expect(check(`${ALLOWED}:443/health`).ok).toBe(true);
  });

  it.each([
    ["https://evil.test", "an origin nobody approved"],
    ["https://gateway.private-channels.test.evil.test", "a suffix that swallows the allowed host"],
    ["https://evil.gateway.private-channels.test", "a subdomain of the allowed host"],
    ["https://gateway.private-channels.test:8443", "the allowed host on another port"],
    ["http://gateway.private-channels.test", "the allowed host over plaintext"],
  ])("refuses %s (%s)", (url) => {
    const result = check(url);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("narrowing");
    expect(result.error).toMatch(/not on this deployment's approved/i);
  });

  it.each([
    ["https://gateway.private-channels.test@evil.test/", "userinfo naming the allowed host"],
    ["https://user:pass@gateway.private-channels.test/", "embedded credentials"],
  ])("refuses %s (%s)", (url) => {
    expect(check(url).ok).toBe(false);
  });

  it.each([
    ["file:///etc/passwd", "a non-http scheme"],
    ["gopher://gateway.private-channels.test/", "a non-http scheme on the allowed host"],
    ["not-a-url", "an unparseable URL"],
    ["", "an empty URL"],
  ])("refuses %s (%s)", (url) => {
    expect(check(url).ok).toBe(false);
  });

  /**
   * The URL parser canonicalises each of these to `http://127.0.0.1` or
   * `http://169.254.169.254`, so the allowlist sees the address the socket
   * would, not the spelling the caller chose.
   */
  it.each([
    ["http://127.0.0.1:8899/", "dotted quad loopback"],
    ["http://2130706433/", "loopback as a decimal integer"],
    ["http://0x7f.0.0.1/", "loopback with a hex octet"],
    ["http://017700000001/", "loopback in octal"],
    ["http://127.1/", "loopback in short form"],
    ["http://%31%32%37%2e%30%2e%30%2e%31/", "percent-encoded loopback"],
    ["http://169.254.169.254/latest/meta-data/", "the metadata address"],
    ["http://[::1]:8899/", "IPv6 loopback"],
    ["http://[::ffff:169.254.169.254]/", "the metadata address as IPv4-mapped IPv6"],
    ["http://[fd00::1]/", "an IPv6 unique-local address"],
  ])("refuses %s (%s)", (url) => {
    expect(check(url).ok).toBe(false);
  });

  it("matches a trailing-dot host against the entry for the same host", () => {
    // `gateway.private-channels.test.` reaches the approved host, so it is the
    // approved host — otherwise the same destination would be refused for a
    // spelling difference the DNS resolver does not observe.
    expect(check("https://gateway.private-channels.test./health").ok).toBe(true);
    expect(check("https://evil.test./").ok).toBe(false);
  });

  it("carries the entry's own plaintext approval, and only for that entry", () => {
    const plaintext = check("http://10.0.0.7:8899/health");
    expect(plaintext.ok).toBe(true);
    if (!plaintext.ok) throw new Error("narrowing");
    expect(plaintext.approved.insecure).toBe(true);

    const https = check(`${ALLOWED}/health`);
    if (!https.ok) throw new Error("narrowing");
    expect(https.approved.insecure).toBe(false);

    // Another private address is not approved just because one of them is.
    expect(check("http://10.0.0.8:8899/health").ok).toBe(false);
  });

  it("keeps the DNS guard on a plaintext entry named by hostname", () => {
    const allowlist = buildPrivateChannelEgressAllowlist(["http://plain.private-channels.test"]);
    const checked = checkPrivateChannelDestination(
      "http://plain.private-channels.test/health",
      allowlist,
      "gatewayUrl"
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error("narrowing");
    expect(checked.approved.plaintext).toBe(true);
    expect(checked.approved.insecure).toBe(false);
  });

  it("skips the address check only for a bracketed private literal, brackets stripped", () => {
    const allowlist = buildPrivateChannelEgressAllowlist(["http://[::1]:8899"]);
    const checked = checkPrivateChannelDestination(
      "http://[::1]:8899/health",
      allowlist,
      "gatewayUrl"
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error("narrowing");
    expect(checked.approved.insecure).toBe(true);
  });

  it("approves nothing from an entry it cannot parse", () => {
    const broken = buildPrivateChannelEgressAllowlist(["gateway.private-channels.test", "   "]);

    expect(broken.size).toBe(0);
  });
});

describe("resolvePrivateChannelEgressAllowlist", () => {
  it("approves the built-in sandbox without any configuration", () => {
    const list = resolvePrivateChannelEgressAllowlist(envWith(undefined));

    expect(list.has(new URL(SANDBOX_DEFAULTS.gatewayUrl).origin)).toBe(true);
    expect(list.has(new URL(SANDBOX_DEFAULTS.authUrl).origin)).toBe(true);
  });

  it("adds the operator's origins and nothing else", () => {
    const list = resolvePrivateChannelEgressAllowlist(
      envWith(` ${ALLOWED} , https://auth.private-channels.test:8903 ,`)
    );

    expect(list.has(ALLOWED)).toBe(true);
    expect(list.has("https://auth.private-channels.test:8903")).toBe(true);
    expect(list.has("https://evil.test")).toBe(false);
  });
});

describe("assertApprovedPrivateChannelDestinations", () => {
  const env = envWith(ALLOWED);

  it("passes when both URLs are approved", () => {
    expect(() =>
      assertApprovedPrivateChannelDestinations(env, {
        gatewayUrl: ALLOWED,
        authUrl: SANDBOX_DEFAULTS.authUrl,
      })
    ).not.toThrow();
  });

  it("names each unapproved URL as its own field error", () => {
    let details: unknown;
    try {
      assertApprovedPrivateChannelDestinations(env, {
        gatewayUrl: "http://169.254.169.254/",
        authUrl: "https://evil.test",
      });
      throw new Error("expected a rejection");
    } catch (error) {
      details = (error as { details?: unknown }).details;
    }

    const fieldErrors = (details as { fieldErrors?: Record<string, string[]> }).fieldErrors;
    expect(Object.keys(fieldErrors ?? {}).sort()).toEqual(["authUrl", "gatewayUrl"]);
  });
});

describe("createPrivateChannelProbeTransport", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  /** A loopback server the test can approve explicitly, the way an operator would. */
  async function startServer(
    handler: Parameters<typeof createServer>[1]
  ): Promise<{ origin: string }> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}` };
  }

  it("refuses a destination that is not on the allowlist, without dialling it", async () => {
    let dialled = false;
    const { origin } = await startServer((_req, res) => {
      dialled = true;
      res.end("{}");
    });
    const transport = createPrivateChannelProbeTransport(envWith(ALLOWED));

    await expect(
      transport({ url: `${origin}/health`, method: "GET", headers: {}, timeoutMs: 2000 })
    ).rejects.toThrow(/not on this deployment's approved/i);
    expect(dialled).toBe(false);
  });

  it("reaches an origin the operator approved", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    const transport = createPrivateChannelProbeTransport(envWith(origin));

    const response = await transport({
      url: `${origin}/health`,
      method: "GET",
      headers: {},
      timeoutMs: 2000,
    });

    expect(response.ok).toBe(true);
    expect(response.text).toContain("ok");
  });

  it("does not follow a redirect off the approved origin", async () => {
    let reachedTarget = false;
    const { origin: target } = await startServer((_req, res) => {
      reachedTarget = true;
      res.end("secret");
    });
    const { origin } = await startServer((_req, res) => {
      res.writeHead(302, { Location: `${target}/latest/meta-data/` });
      res.end();
    });
    const transport = createPrivateChannelProbeTransport(envWith(`${origin},${target}`));

    const response = await transport({
      url: `${origin}/health`,
      method: "GET",
      headers: {},
      timeoutMs: 2000,
    });

    // Even with the redirect target itself approved, the hop is not taken: the
    // probe reports the 302 and the caller sees an endpoint that is not ready.
    expect(response.status).toBe(302);
    expect(response.ok).toBe(false);
    expect(reachedTarget).toBe(false);
  });

  it("stops reading a response the endpoint pads out", async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(512 * 1024));
    });
    const transport = createPrivateChannelProbeTransport(envWith(origin));

    const response = await transport({
      url: `${origin}/health`,
      method: "GET",
      headers: {},
      timeoutMs: 5000,
    });

    expect(response.text.length).toBe(64 * 1024);
  });
});
