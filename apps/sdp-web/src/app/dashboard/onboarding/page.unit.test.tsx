import { CUSTODY_PROVIDERS, ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetchProviderAvailability: vi.fn(),
  organizationFetch: vi.fn(),
  organizationOnboarding: vi.fn(),
  organizationRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirected to ${path}`);
  }),
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));
vi.mock("@/flags", () => ({
  organizationOnboarding: mocks.organizationOnboarding,
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/provider-availability", () => ({
  fetchProviderAvailability: mocks.fetchProviderAvailability,
}));
vi.mock("@/lib/sdp-api", () => ({
  createRequestScopedSdpApiClients: vi.fn(async () => ({
    organizationClient: {
      fetch: mocks.organizationFetch,
      request: mocks.organizationRequest,
    },
    projectClient: null,
  })),
}));

import OrganizationOnboardingPage from "./page";

const unavailable = {
  configured: false,
  enabled: false,
  entitled: true,
};

function providerAvailability({
  custody = {},
  rpc = {},
}: {
  custody?: Record<string, Partial<typeof unavailable>>;
  rpc?: Record<string, Partial<typeof unavailable>>;
}) {
  const entry = (override: Partial<typeof unavailable> = {}) => ({
    ...unavailable,
    ...override,
  });

  return {
    providers: {
      compliance: {},
      custody: Object.fromEntries(
        CUSTODY_PROVIDERS.map((provider) => [provider, entry(custody[provider])])
      ),
      ramps: {},
      rpc: Object.fromEntries(
        ORGANIZATION_RPC_PROVIDERS.map((provider) => [provider, entry(rpc[provider])])
      ),
    },
  };
}

async function renderPage() {
  const page = await OrganizationOnboardingPage();
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {page}
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.fetchProviderAvailability.mockReset();
  mocks.organizationFetch.mockReset();
  mocks.organizationOnboarding.mockReset();
  mocks.organizationRequest.mockReset();

  mocks.auth.mockResolvedValue({
    getToken: vi.fn(),
    orgId: "org_test",
    userId: "user_test",
  });
  mocks.organizationOnboarding.mockResolvedValue(true);
  mocks.organizationFetch.mockResolvedValue({
    linked: true,
    organization: { id: "org_test" },
    setup: {
      canManage: true,
      completedAt: null,
      currentStep: "rpc",
      custodyProvider: null,
      rpcProvider: null,
      status: "not_started",
      version: 1,
    },
  });
});

describe("OrganizationOnboardingPage", () => {
  it("shows only named RPC providers currently available to the organization", async () => {
    mocks.fetchProviderAvailability.mockResolvedValue(
      providerAvailability({
        rpc: {
          default: { configured: true, enabled: true },
          helius: { configured: true, enabled: true },
          nodit: { configured: true, enabled: false, entitled: false },
        },
      })
    );

    const markup = await renderPage();

    expect(markup).toContain("Helius");
    expect(markup).not.toContain("Nodit");
    expect(markup).not.toContain("SDP RPC");
  });

  it("shows only custody providers currently available to the organization", async () => {
    mocks.organizationFetch.mockResolvedValue({
      linked: true,
      organization: { id: "org_test" },
      setup: {
        canManage: true,
        completedAt: null,
        currentStep: "custody",
        custodyProvider: null,
        rpcProvider: "helius",
        status: "in_progress",
        version: 1,
      },
    });
    mocks.fetchProviderAvailability.mockResolvedValue(
      providerAvailability({
        custody: {
          para: { configured: true, enabled: true },
          privy: { configured: true, enabled: false, entitled: false },
        },
        rpc: {
          helius: { configured: true, enabled: true },
        },
      })
    );

    const markup = await renderPage();

    expect(markup).toContain("Para");
    expect(markup).not.toContain("Privy");
  });

  it("uses the default RPC and skips RPC selection when no named provider is available", async () => {
    mocks.fetchProviderAvailability.mockResolvedValue(
      providerAvailability({
        custody: {
          para: { configured: true, enabled: true },
        },
        rpc: {
          default: { configured: true, enabled: true },
        },
      })
    );

    const markup = await renderPage();

    expect(markup).toContain("Choose your custody provider");
    expect(markup).toContain("Step 1 of 1");
    expect(markup).toContain("Para");
    expect(markup).not.toContain("Choose your RPC provider");
    expect(markup).not.toContain(">Back<");
  });

  it("blocks onboarding when no RPC provider is available", async () => {
    mocks.organizationFetch.mockResolvedValue({
      linked: true,
      organization: { id: "org_test" },
      setup: {
        canManage: true,
        completedAt: null,
        currentStep: "custody",
        custodyProvider: null,
        rpcProvider: "helius",
        status: "in_progress",
        version: 1,
      },
    });
    mocks.fetchProviderAvailability.mockResolvedValue(providerAvailability({}));

    const markup = await renderPage();

    expect(markup).toContain("Choose your RPC provider");
    expect(markup).toContain(
      "No RPC providers are available for this organization in the current environment. Contact your SDP administrator before continuing."
    );
    expect(markup).not.toContain("Choose your custody provider");
    expect(markup).toContain('disabled=""');
  });
});
