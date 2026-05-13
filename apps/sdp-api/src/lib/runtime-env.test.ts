import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { getDeploymentMode, getRuntime, isSelfHostedDeployment } from "./runtime-env";

const envWith = (mode: string | undefined): Pick<Env, "SDP_DEPLOYMENT_MODE"> =>
  ({ SDP_DEPLOYMENT_MODE: mode }) as Pick<Env, "SDP_DEPLOYMENT_MODE">;

const envWithRuntime = (runtime: string | undefined): Pick<Env, "SDP_RUNTIME"> =>
  ({ SDP_RUNTIME: runtime }) as Pick<Env, "SDP_RUNTIME">;

describe("getDeploymentMode", () => {
  it("defaults to managed when SDP_DEPLOYMENT_MODE is unset", () => {
    expect(getDeploymentMode(envWith(undefined))).toBe("managed");
  });

  it("accepts the documented values", () => {
    expect(getDeploymentMode(envWith("managed"))).toBe("managed");
    expect(getDeploymentMode(envWith("self_hosted"))).toBe("self_hosted");
  });

  it("throws on a typo'd value (selfhosted, no underscore)", () => {
    expect(() => getDeploymentMode(envWith("selfhosted"))).toThrow(
      /Invalid SDP_DEPLOYMENT_MODE.*selfhosted/
    );
  });

  it("throws on any other unknown value", () => {
    expect(() => getDeploymentMode(envWith("hosted"))).toThrow(/Invalid SDP_DEPLOYMENT_MODE/);
    expect(() => getDeploymentMode(envWith(""))).toThrow(/Invalid SDP_DEPLOYMENT_MODE/);
  });
});

describe("isSelfHostedDeployment", () => {
  it("returns false for managed (default)", () => {
    expect(isSelfHostedDeployment(envWith(undefined))).toBe(false);
    expect(isSelfHostedDeployment(envWith("managed"))).toBe(false);
  });

  it("returns true for self_hosted", () => {
    expect(isSelfHostedDeployment(envWith("self_hosted"))).toBe(true);
  });

  it("propagates the validation error for invalid values", () => {
    expect(() => isSelfHostedDeployment(envWith("selfhosted"))).toThrow(
      /Invalid SDP_DEPLOYMENT_MODE/
    );
  });
});

describe("getRuntime", () => {
  it("defaults to cloudflare when SDP_RUNTIME is unset", () => {
    expect(getRuntime(envWithRuntime(undefined))).toBe("cloudflare");
  });

  it("accepts the documented values", () => {
    expect(getRuntime(envWithRuntime("cloudflare"))).toBe("cloudflare");
    expect(getRuntime(envWithRuntime("node"))).toBe("node");
  });

  it("throws on a typo'd value (Node, capitalized)", () => {
    expect(() => getRuntime(envWithRuntime("Node"))).toThrow(/Invalid SDP_RUNTIME.*Node/);
  });

  it("throws on any other unknown value", () => {
    expect(() => getRuntime(envWithRuntime("nodejs"))).toThrow(/Invalid SDP_RUNTIME/);
    expect(() => getRuntime(envWithRuntime(""))).toThrow(/Invalid SDP_RUNTIME/);
  });
});
