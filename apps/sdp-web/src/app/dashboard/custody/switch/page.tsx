import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sdpApiRequest } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { switchCustodyProvider } from "../actions";
import { type SwitchProvider, SwitchProviderForm } from "./switch-provider-form";

const PROVIDER_OPTIONS: Array<{ value: SwitchProvider; label: string }> = [
  { value: "privy", label: "Privy" },
  { value: "fireblocks", label: "Fireblocks" },
  { value: "coinbase_cdp", label: "Coinbase CDP" },
  { value: "para", label: "Para" },
  { value: "turnkey", label: "Turnkey" },
  { value: "local", label: "Local (development only)" },
];

const DEFAULT_HAS_REUSABLE_WALLET_BY_PROVIDER: Record<SwitchProvider, boolean> = {
  fireblocks: false,
  privy: false,
  coinbase_cdp: false,
  para: false,
  turnkey: false,
  local: false,
};

const DEFAULT_NEEDS_WALLET_LABEL_BY_PROVIDER: Record<SwitchProvider, boolean> = {
  fireblocks: false,
  privy: true,
  coinbase_cdp: true,
  para: true,
  turnkey: true,
  local: true,
};

const DEFAULT_IS_ACTIVE_BY_PROVIDER: Record<SwitchProvider, boolean> = {
  fireblocks: false,
  privy: false,
  coinbase_cdp: false,
  para: false,
  turnkey: false,
  local: false,
};

const DEFAULT_IS_DEFAULT_BY_PROVIDER: Record<SwitchProvider, boolean> = {
  fireblocks: false,
  privy: false,
  coinbase_cdp: false,
  para: false,
  turnkey: false,
  local: false,
};

function formatProviderName(provider: string): string {
  const option = PROVIDER_OPTIONS.find((entry) => entry.value === provider);
  if (option) {
    return option.label;
  }
  return provider;
}

async function getProviderCapabilities(): Promise<{
  hasReusableWalletByProvider: Record<SwitchProvider, boolean>;
  needsWalletLabelByProvider: Record<SwitchProvider, boolean>;
  isActiveByProvider: Record<SwitchProvider, boolean>;
  isDefaultByProvider: Record<SwitchProvider, boolean>;
}> {
  const response = await sdpApiRequest("/v1/wallets/switch-options");
  if (!response.ok) {
    return {
      hasReusableWalletByProvider: DEFAULT_HAS_REUSABLE_WALLET_BY_PROVIDER,
      needsWalletLabelByProvider: DEFAULT_NEEDS_WALLET_LABEL_BY_PROVIDER,
      isActiveByProvider: DEFAULT_IS_ACTIVE_BY_PROVIDER,
      isDefaultByProvider: DEFAULT_IS_DEFAULT_BY_PROVIDER,
    };
  }

  const payload = (await response.json()) as {
    data?: {
      providers?: Array<{
        provider?: string;
        hasReusableWallet?: boolean;
        needsWalletLabel?: boolean;
        isActive?: boolean;
        isDefault?: boolean;
      }>;
    };
  };

  const hasReusableWalletByProvider = { ...DEFAULT_HAS_REUSABLE_WALLET_BY_PROVIDER };
  const needsWalletLabelByProvider = { ...DEFAULT_NEEDS_WALLET_LABEL_BY_PROVIDER };
  const isActiveByProvider = { ...DEFAULT_IS_ACTIVE_BY_PROVIDER };
  const isDefaultByProvider = { ...DEFAULT_IS_DEFAULT_BY_PROVIDER };
  for (const provider of payload.data?.providers ?? []) {
    if (!provider.provider || !(provider.provider in needsWalletLabelByProvider)) {
      continue;
    }

    const key = provider.provider as SwitchProvider;
    if (typeof provider.hasReusableWallet === "boolean") {
      hasReusableWalletByProvider[key] = provider.hasReusableWallet;
    }

    if (typeof provider.needsWalletLabel === "boolean") {
      needsWalletLabelByProvider[key] = provider.needsWalletLabel;
    }

    if (typeof provider.isActive === "boolean") {
      isActiveByProvider[key] = provider.isActive;
    }

    if (typeof provider.isDefault === "boolean") {
      isDefaultByProvider[key] = provider.isDefault;
    }
  }

  return {
    hasReusableWalletByProvider,
    needsWalletLabelByProvider,
    isActiveByProvider,
    isDefaultByProvider,
  };
}

export default async function CustodySwitchPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const {
    hasReusableWalletByProvider,
    needsWalletLabelByProvider,
    isActiveByProvider,
    isDefaultByProvider,
  } = await getProviderCapabilities();
  const currentDefaultProvider =
    (Object.entries(isDefaultByProvider).find(([, isDefault]) => isDefault)?.[0] as
      | SwitchProvider
      | undefined) ?? null;
  const defaultProvider = currentDefaultProvider ?? PROVIDER_OPTIONS[0].value;
  const providerOptions = PROVIDER_OPTIONS.map((option) => ({
    value: option.value,
    label: `${option.label}${
      isDefaultByProvider[option.value]
        ? " (default)"
        : isActiveByProvider[option.value]
          ? " (connected)"
          : ""
    }`,
    disabled: false,
  }));

  return (
    <div className="w-full max-w-3xl flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Set default / connect provider</CardTitle>
          <CardDescription>
            Selecting a connected provider sets it as default. Selecting a new provider connects it
            and sets it as default. Existing on-chain authorities are not rotated automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {currentDefaultProvider ? (
            <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
              Current default provider:{" "}
              <span className="font-medium text-[#1c1c1d]">
                {formatProviderName(currentDefaultProvider)}
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
            disableSubmit={providerOptions.length === 0}
            hasReusableWalletByProvider={hasReusableWalletByProvider}
            needsWalletLabelByProvider={needsWalletLabelByProvider}
            isActiveByProvider={isActiveByProvider}
          />
        </CardContent>
      </Card>
    </div>
  );
}
