import { DEFAULT_SDP_AI_LLMS_URL } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";
import {
  DASHBOARD_PATH,
  externalLinkProps,
  resolveHomepageLinks,
  waitlistHref,
} from "./homepage-links";

const labels = {
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
    expect(links.signIn).toBe(AUTH_ENTRY_PATH);
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
});
