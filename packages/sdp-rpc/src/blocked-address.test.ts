import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertReachableTenantEndpoint, isBlockedAddress } from "./blocked-address";

function assertUnreachable(endpointUrl: string): void {
  assert.throws(
    () => assertReachableTenantEndpoint(endpointUrl),
    { name: "SdpRpcError", code: "BAD_REQUEST", message: /not reachable/i },
    endpointUrl
  );
}

describe("assertReachableTenantEndpoint", () => {
  it("refuses the cloud metadata address", () => {
    assertUnreachable("https://169.254.169.254/latest/meta-data");
  });

  it("refuses loopback and private IPv4 ranges", () => {
    for (const endpointUrl of [
      "https://127.0.0.1/rpc",
      "https://10.0.0.5/rpc",
      "https://192.168.1.10/rpc",
      "https://172.16.4.4/rpc",
    ]) {
      assertUnreachable(endpointUrl);
    }
  });

  it("refuses localhost and reserved internal suffixes", () => {
    for (const endpointUrl of [
      "https://localhost/rpc",
      "https://LOCALHOST/rpc",
      "https://api.localhost/rpc",
      "https://vault.internal/rpc",
      "https://printer.local/rpc",
    ]) {
      assertUnreachable(endpointUrl);
    }
  });

  it("refuses IPv6 loopback, unspecified, unique-local and link-local literals", () => {
    for (const endpointUrl of [
      "https://[::1]/rpc",
      "https://[0:0:0:0:0:0:0:1]/rpc",
      "https://[::]/rpc",
      "https://[fd00::1]/rpc",
      "https://[fc00::1]/rpc",
      "https://[fe80::1]/rpc",
      "https://[fe80::a00:27ff:fe4e:66a1]/rpc",
      "https://[fe80::a9fe:a9fe]/rpc",
    ]) {
      assertUnreachable(endpointUrl);
    }
  });

  it("refuses an IPv4-mapped private address the parser rewrites to hex", () => {
    assert.equal(new URL("https://[::ffff:127.0.0.1]/rpc").hostname, "[::ffff:7f00:1]");
    assertUnreachable("https://[::ffff:127.0.0.1]/rpc");
    assertUnreachable("https://[::ffff:169.254.169.254]/rpc");
    assertUnreachable("https://[::ffff:7f00:1]/rpc");
  });

  it("allows a routable IPv6 endpoint and a routable IPv4-mapped one", () => {
    assert.doesNotThrow(() => assertReachableTenantEndpoint("https://[2606:4700::1111]/rpc"));
    assert.doesNotThrow(() => assertReachableTenantEndpoint("https://[::ffff:8.8.8.8]/rpc"));
  });

  it("refuses every range the connect-time guard refuses", () => {
    const blockedHosts = [
      { endpointUrl: "https://100.64.0.1/rpc", address: "100.64.0.1" },
      { endpointUrl: "https://100.127.255.254/rpc", address: "100.127.255.254" },
      { endpointUrl: "https://198.18.0.1/rpc", address: "198.18.0.1" },
      { endpointUrl: "https://192.0.0.170/rpc", address: "192.0.0.170" },
      { endpointUrl: "https://224.0.0.1/rpc", address: "224.0.0.1" },
      { endpointUrl: "https://255.255.255.255/rpc", address: "255.255.255.255" },
      { endpointUrl: "https://0.1.2.3/rpc", address: "0.1.2.3" },
      { endpointUrl: "https://[ff02::1]/rpc", address: "ff02::1" },
    ];
    for (const { endpointUrl, address } of blockedHosts) {
      assert.equal(isBlockedAddress(address), true, address);
      assertUnreachable(endpointUrl);
    }
  });

  it("allows the addresses just outside the CGNAT range, matching the connect-time guard", () => {
    for (const address of ["100.63.255.255", "100.128.0.1"]) {
      assert.equal(isBlockedAddress(address), false, address);
      assert.doesNotThrow(() => assertReachableTenantEndpoint(`https://${address}/rpc`));
    }
  });

  it("refuses credentials embedded in the URL", () => {
    for (const endpointUrl of [
      "https://user:pass@rpc.example.com/",
      "https://token@rpc.example.com/",
    ]) {
      assert.throws(() => assertReachableTenantEndpoint(endpointUrl), {
        name: "SdpRpcError",
        code: "BAD_REQUEST",
        message: /credential/i,
      });
    }
  });

  it("refuses plaintext http", () => {
    assert.throws(() => assertReachableTenantEndpoint("http://rpc.example.com"), {
      name: "SdpRpcError",
      code: "BAD_REQUEST",
      message: /https/i,
    });
  });

  it("refuses a malformed URL", () => {
    assert.throws(() => assertReachableTenantEndpoint("not-a-url"), {
      name: "SdpRpcError",
      code: "BAD_REQUEST",
      message: /valid URL/i,
    });
  });

  it("allows an ordinary public endpoint", () => {
    assert.doesNotThrow(() => assertReachableTenantEndpoint("https://rpc.example.com"));
    assert.doesNotThrow(() => assertReachableTenantEndpoint("https://tenant.example.org/v1/rpc"));
  });
});
