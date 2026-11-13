import { DEFAULT_SDP_AI_LLMS_URL } from "@sdp/types/site";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_PATH } from "@/lib/clerk-config";
import {
  DASHBOARD_PATH,
  externalLinkProps,
  resolveHomepageLinks,
  waitlistHref,
} from "./homepage-links";

const labels = {
  trySandboxLabel: "Try the sandbox",
  createAccountLabel: "Create account",
  joinWaitlistLabel: "Join the waitlist",
  dashboardLabel: "Dashboard",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveHomepageLinks", () => {
  it("sends Create account to the sign-up form while open signup is on", () => {
    const links = resolveHomepageLinks({ openSignup: true, ...labels });

    expect(links.signup).toEqual({ href: "/sign-up", label: "Create account", external: false });
    expect(links.signIn).toBe(SIGN_IN_PATH);
  });

  it("sends visitors to the off-site waitlist while open signup is off", () => {
    const links = resolveHomepageLinks({ openSignup: false, ...labels });

    expect(links.signup).toEqual({
      href: waitlistHref,
      label: "Join the waitlist",
      external: true,
    });
  });

  it.each([true, false])(
    "sends a signed-in visitor to the dashboard whatever open signup is (%s)",
    (openSignup) => {
      const links = resolveHomepageLinks({ signedIn: true, openSignup, ...labels });

      expect(links.signup).toEqual({ href: DASHBOARD_PATH, label: "Dashboard", external: false });
      expect(links.signIn).toBe(DASHBOARD_PATH);
      expect(links.signedIn).toBe(true);
    }
  );

  it("points the docs, the API reference and llms.txt at the docs site", () => {
    vi.stubEnv("NEXT_PUBLIC_SDP_DOCS_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const links = resolveHomepageLinks({ openSignup: true, ...labels });

    expect(links.docs).toMatch(/\/docs$/);
    expect(links.openapi).toBe(`${links.docs}/reference/api`);
    expect(links.llms).toBe(DEFAULT_SDP_AI_LLMS_URL);
  });

  it("keeps a configured docs origin for llms.txt", () => {
    vi.stubEnv("NEXT_PUBLIC_SDP_DOCS_URL", "https://preview.example/docs");
    const links = resolveHomepageLinks({ openSignup: true, ...labels });

    expect(links.llms).toBe("https://preview.example/docs/ai/llms.txt");
  });
});

describe("externalLinkProps", () => {
  it("opens off-site links in a new tab and leaves the rest alone", () => {
    expect(externalLinkProps(true)).toEqual({ target: "_blank", rel: "noreferrer" });
    expect(externalLinkProps(false)).toEqual({ target: undefined, rel: undefined });
  });

  it("sends the sandbox links to the hosted sandbox when the deployment serves mainnet only", () => {
    const links = resolveHomepageLinks({ openSignup: true, hostedSandbox: true, ...labels });
    expect(links.signup).toEqual({ href: "/sign-up", label: "Create account", external: false });
    expect(links.sandbox).toEqual({
      href: "https://platform-beta.solana.com/sign-up",
      label: "Try the sandbox",
      external: true,
    });
  });

  it("keeps the sandbox links on the account entry otherwise", () => {
    const links = resolveHomepageLinks({ openSignup: true, ...labels });
    expect(links.sandbox).toEqual(links.signup);
  });
});
