import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiMethod } from "@sdp/api-catalog/reference";
import { getPlaygroundHref } from "@/lib/playground-link";

describe("API reference playground links", () => {
  const examples: {
    method: ApiMethod;
    path: string;
    returnTo: string;
  }[] = [
    {
      method: "GET",
      path: "/v1/wallets",
      returnTo: "/dashboard/wallets?tab=playground&endpoint=list-wallets",
    },
    {
      method: "POST",
      path: "/v1/payments/transfers",
      returnTo: "/dashboard/payments?tab=playground&endpoint=create-payment-transfer",
    },
    {
      method: "GET",
      path: "/v1/counterparties",
      returnTo: "/dashboard/payments?tab=playground&endpoint=list-counterparties",
    },
    {
      method: "GET",
      path: "/v1/issuance/templates",
      returnTo: "/dashboard/issuance?tab=playground&endpoint=list-token-templates",
    },
  ];
  for (const { method, path, returnTo } of examples) {
    it(`lands ${method} ${path} on its selected endpoint after sign-in`, () => {
      const href = getPlaygroundHref(method, path, "https://dashboard.example.com/docs");
      assert.ok(href);
      const landing = new URL(href);
      assert.equal(landing.origin, "https://dashboard.example.com");
      assert.equal(landing.pathname, "/dashboard");
      assert.equal(landing.searchParams.get("return_to"), returnTo);
    });
  }

  it("omits operations outside the dashboard catalog", () => {
    assert.equal(getPlaygroundHref("GET", "/health", "https://dashboard.example.com"), null);
    assert.equal(getPlaygroundHref("GET", "/v1/projects", "https://dashboard.example.com"), null);
  });

  it("hides the action when no dashboard URL is configured", () => {
    assert.equal(getPlaygroundHref("GET", "/v1/wallets", null), null);
  });
});
