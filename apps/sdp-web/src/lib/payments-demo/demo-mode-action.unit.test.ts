import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The demo switch is a server action, so anyone can call it directly: it must do nothing for a
 * caller who isn't signed in to an organization, and turn the demo on only while its flag is.
 */

const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  auth: { userId: "user_1" as string | null, orgId: "org_1" as string | null },
  demoFlag: true,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      state.jar.has(name) ? { name, value: state.jar.get(name) ?? "" } : undefined,
    getAll: () => [...state.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      state.jar.set(name, value);
    },
    delete: (name: string) => {
      state.jar.delete(name);
    },
  }),
}));
vi.mock("../sdp-api", () => ({ getSdpAuth: async () => state.auth }));
vi.mock("@/flags", () => ({ paymentsDemoMode: async () => state.demoFlag }));

const { setPaymentsDemoAction } = await import("./demo-mode-action");
const { PROJECT_COOKIE_NAME } = await import("../project-cookie");

beforeEach(() => {
  state.jar.clear();
  state.auth = { userId: "user_1", orgId: "org_1" };
  state.demoFlag = true;
});

describe("setPaymentsDemoAction", () => {
  it("names the selected project and forgets the session so far", async () => {
    state.jar.set("sdp-demo-session.0", "abc");
    state.jar.set("sdp-demo-session.1", "def");
    state.jar.set("other", "kept");

    expect(await setPaymentsDemoAction(true, "proj_sandbox")).toBe(true);

    expect(Object.fromEntries(state.jar)).toEqual({
      other: "kept",
      "sdp-payments-demo": "proj_sandbox",
    });
  });

  it("does not take the project from the last-used project cookie", async () => {
    state.jar.set(PROJECT_COOKIE_NAME, "prj_cookie");

    expect(await setPaymentsDemoAction(true, null)).toBe(false);
    expect(state.jar.has("sdp-payments-demo")).toBe(false);
  });

  it("refuses a missing project or one that isn't cookie-safe", async () => {
    expect(await setPaymentsDemoAction(true, null)).toBe(false);
    expect(await setPaymentsDemoAction(true, "proj; Path=/")).toBe(false);
    expect(state.jar.has("sdp-payments-demo")).toBe(false);
  });

  it("turns the demo off and forgets its session", async () => {
    state.jar.set("sdp-payments-demo", "proj_sandbox");
    state.jar.set("sdp-demo-session.0", "abc");

    expect(await setPaymentsDemoAction(false, "proj_sandbox")).toBe(true);
    expect(state.jar.size).toBe(0);
  });

  it("does nothing for a caller who isn't signed in to an organization", async () => {
    state.jar.set("sdp-payments-demo", "proj_sandbox");
    state.jar.set("sdp-demo-session.0", "abc");

    state.auth = { userId: null, orgId: null };
    expect(await setPaymentsDemoAction(false, "proj_sandbox")).toBe(false);
    state.auth = { userId: "user_1", orgId: null };
    expect(await setPaymentsDemoAction(true, "proj_other")).toBe(false);

    expect(Object.fromEntries(state.jar)).toEqual({
      "sdp-payments-demo": "proj_sandbox",
      "sdp-demo-session.0": "abc",
    });
  });

  it("won't turn the demo on with its flag off, but still turns it off", async () => {
    state.demoFlag = false;

    expect(await setPaymentsDemoAction(true, "proj_sandbox")).toBe(false);
    expect(state.jar.has("sdp-payments-demo")).toBe(false);

    state.jar.set("sdp-payments-demo", "proj_sandbox");
    expect(await setPaymentsDemoAction(false, "proj_sandbox")).toBe(true);
    expect(state.jar.has("sdp-payments-demo")).toBe(false);
  });
});
