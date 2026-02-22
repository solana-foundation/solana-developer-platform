import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sdpApiRequest } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { switchCustodyProvider } from "../actions";

type SwitchProvider = "privy" | "coinbase_cdp" | "local";

const PROVIDER_OPTIONS: Array<{ value: SwitchProvider; label: string }> = [
  { value: "privy", label: "Privy" },
  { value: "coinbase_cdp", label: "Coinbase CDP" },
  { value: "local", label: "Local (development only)" },
];

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

export default async function CustodySwitchPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const currentProvider = await getCurrentProvider();
  const selectableOptions = PROVIDER_OPTIONS.filter((option) => option.value !== currentProvider);
  const defaultProvider = selectableOptions[0]?.value ?? PROVIDER_OPTIONS[0].value;

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

          <form action={switchCustodyProvider} className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="provider">New provider</Label>
              <select
                id="provider"
                name="provider"
                className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                defaultValue={defaultProvider}
                disabled={selectableOptions.length === 0}
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.value === currentProvider}
                  >
                    {option.label}
                    {option.value === currentProvider ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirm">Confirmation</Label>
              <Input id="confirm" name="confirm" placeholder="SWITCH" />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={selectableOptions.length === 0}>
                Switch provider
              </Button>
              <Link href="/dashboard/wallets">
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
