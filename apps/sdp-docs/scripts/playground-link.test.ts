import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ApiMethod } from "@sdp/api-catalog/reference";
import { getPlaygroundHref } from "@/lib/playground-link";

describe("API reference playground links", () => {
  const original = {
    url: process.env.NEXT_PUBLIC_SDP_WEB_URL,
    vercelEnv: process.env.VERCEL_ENV,
    related: process.env.VERCEL_RELATED_PROJECTS,
  };
  before(() => {
    process.env.NEXT_PUBLIC_SDP_WEB_URL = "https://dashboard.example.com/docs";
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_RELATED_PROJECTS;
  });
  after(() => {
    for (const [key, value] of [
      ["NEXT_PUBLIC_SDP_WEB_URL", original.url],
      ["VERCEL_ENV", original.vercelEnv],
      ["VERCEL_RELATED_PROJECTS", original.related],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

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
      const href = getPlaygroundHref(method, path);
      assert.ok(href);
      const landing = new URL(href);
      assert.equal(landing.origin, "https://dashboard.example.com");
      assert.equal(landing.pathname, "/dashboard");
      assert.equal(landing.searchParams.get("return_to"), returnTo);
    });
  }

  it("omits operations outside the dashboard catalog", () => {
    assert.equal(getPlaygroundHref("GET", "/health"), null);
    assert.equal(getPlaygroundHref("GET", "/v1/projects"), null);
  });

  it("hides the action when no dashboard URL is configured", () => {
    process.env.VERCEL_ENV = "preview";
    try {
      assert.equal(getPlaygroundHref("GET", "/v1/wallets"), null);
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });
});
