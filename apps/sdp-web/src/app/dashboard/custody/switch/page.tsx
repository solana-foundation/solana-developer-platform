import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sdpApiRequest } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { switchCustodyProvider } from "../actions";
import { SwitchProviderForm, type SwitchProvider } from "./switch-provider-form";

const PROVIDER_OPTIONS: Array<{ value: SwitchProvider; label: string }> = [
  { value: "privy", label: "Privy" },
  { value: "coinbase_cdp", label: "Coinbase CDP" },
  { value: "turnkey", label: "Turnkey" },
  { value: "local", label: "Local (development only)" },
];

const DEFAULT_NEEDS_WALLET_LABEL_BY_PROVIDER: Record<SwitchProvider, boolean> = {
  privy: true,
  coinbase_cdp: true,
  turnkey: true,
  local: true,
};

function formatProviderName(provider: string): string {
  const option = PROVIDER_OPTIONS.find((entry) => entry.value === provider);
  if (option) {
    return option.label;
  }
  return provider;
}

async function getCurrentProvider(): Promise<string | null> {
  const response = await sdpApiRequest("/v1/wallets/config");
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    data?: {
      config?: {
        provider?: string;
      };
    };
  };
  return payload.data?.config?.provider ?? null;
}

async function getNeedsWalletLabelByProvider(): Promise<Record<SwitchProvider, boolean>> {
  const response = await sdpApiRequest("/v1/wallets/switch-options");
  if (!response.ok) {
    return DEFAULT_NEEDS_WALLET_LABEL_BY_PROVIDER;
  }

  const payload = (await response.json()) as {
    data?: {
      providers?: Array<{
        provider?: string;
        needsWalletLabel?: boolean;
      }>;
    };
  };

  const next = { ...DEFAULT_NEEDS_WALLET_LABEL_BY_PROVIDER };
  for (const provider of payload.data?.providers ?? []) {
    if (
      provider.provider &&
      provider.provider in next &&
      typeof provider.needsWalletLabel === "boolean"
    ) {
      next[provider.provider as SwitchProvider] = provider.needsWalletLabel;
    }
  }

  return next;
}

export default async function CustodySwitchPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const currentProvider = await getCurrentProvider();
  const needsWalletLabelByProvider = await getNeedsWalletLabelByProvider();
  const selectableOptions = PROVIDER_OPTIONS.filter((option) => option.value !== currentProvider);
  const defaultProvider = selectableOptions[0]?.value ?? PROVIDER_OPTIONS[0].value;
  const providerOptions = PROVIDER_OPTIONS.map((option) => ({
    value: option.value,
    label: `${option.label}${option.value === currentProvider ? " (current)" : ""}`,
    disabled: option.value === currentProvider,
  }));

  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Switch wallet provider</CardTitle>
          <CardDescription>
            This updates which provider signs new API actions. It does not automatically rotate
            existing on-chain authorities.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {currentProvider ? (
            <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
              Current provider:{" "}
              <span className="font-medium text-[#1c1c1d]">
                {formatProviderName(currentProvider)}
              </span>
            </div>
          ) : null}
          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.64)]">
            Safeguard: type <span className="font-mono text-[#1c1c1d]">SWITCH</span> to confirm.
          </div>

          <SwitchProviderForm
            action={switchCustodyProvider}
            options={providerOptions}
            defaultProvider={defaultProvider}
            disableSubmit={selectableOptions.length === 0}
            needsWalletLabelByProvider={needsWalletLabelByProvider}
          />
        </CardContent>
      </Card>
    </div>
  );
}
