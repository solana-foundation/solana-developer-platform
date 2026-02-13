import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Coins, Wrench } from "lucide-react";
import { DashboardHeader } from "@/components/dashboard-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { sdpApiRequest } from "@/lib/sdp-api";

interface IssuanceRecord {
  id: string;
  name: string;
  status: "draft" | "ready" | "active" | "paused" | string;
  type?: string;
  template?: string;
  createdAt?: string;
}

interface IssuanceWorkspacePayload {
  issuances?: IssuanceRecord[];
  templates?: string[];
}

interface IssuanceWorkspaceResult {
  ok: boolean;
  status?: number;
  data?: IssuanceWorkspacePayload;
  error?: string;
  requiresApiKey?: boolean;
  apiKeyErrorCode?: string;
}

async function getIssuanceWorkspace(): Promise<IssuanceWorkspaceResult> {
  try {
    const res = await sdpApiRequest("/v1/issuance");

    if (!res.ok) {
      const body = await res.text();
      let parsedErrorCode: string | undefined;
      try {
        const parsed = JSON.parse(body);
        const errorCode =
          parsed?.error?.code ??
          parsed?.code ??
          parsed?.error_code ??
          parsed?.error?.error?.code;
        if (typeof errorCode === "string") {
          parsedErrorCode = errorCode;
        }
      } catch {
        // Ignore parse errors and fall back to raw body text.
      }

      return {
        ok: false,
        status: res.status,
        error: `SDP API returned ${res.status}: ${body}`,
        requiresApiKey: res.status === 401 && parsedErrorCode === "INVALID_API_KEY",
        apiKeyErrorCode: parsedErrorCode,
      };
    }

    const raw = (await res.json()) as {
      data?: IssuanceWorkspacePayload;
      issuances?: IssuanceRecord[];
      templates?: string[];
    };

    const data = raw.data ?? {
      issuances: raw.issuances ?? [],
      templates: raw.templates ?? [],
    };

    return {
      ok: true,
      status: 200,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      status: undefined,
      error: error instanceof Error ? error.message : "Unable to load issuance workspace",
    };
  }
}

function normalizeStatus(status?: string) {
  if (!status) return "draft";
  return status;
}

export default async function IssuancePage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const workspace = await getIssuanceWorkspace();
  const issuances = workspace.data?.issuances ?? [];
  const templates = workspace.data?.templates ?? ["Stablecoin", "Arcade", "Tokenized Security", "Custom"];
  const needsApiKey = workspace.requiresApiKey;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <DashboardHeader title="Issuance" />

      <Card>
        <CardHeader>
          <CardTitle>Issuance center</CardTitle>
          <CardDescription>Launch new tokenized assets and manage minting operations.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-[rgba(28,28,29,0.74)]">
          <p>
            Phase 1 ships the structure for a token issuance experience: discover templates, launch issuances,
            and land the workspace for API-powered actions.
          </p>
          {needsApiKey ? (
            <div className="rounded-lg border border-[#1f6dfd]/30 bg-[#1f6dfd]/5 p-3 text-[#1f3e9d]">
              <p className="mb-2 text-sm">
                No valid API key was found for this organization. Create one first, then return to Issuance to
                continue.
              </p>
              <Button asChild className="bg-[#1c1c1d] text-white hover:bg-black">
                <Link href="/dashboard/api-keys">Create your first API key</Link>
              </Button>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Button className="justify-start gap-2 bg-[#1c1c1d] text-white hover:bg-black">
              <Coins className="h-4 w-4" />
              Start issuance template
            </Button>
            <Button className="justify-start gap-2" variant="secondary">
              <Wrench className="h-4 w-4" />
              Open API playground
            </Button>
            <Button className="justify-start gap-2" variant="secondary" asChild>
              <Link href="/dashboard/api-keys">Create API key</Link>
            </Button>
          </div>
          {workspace.ok || needsApiKey ? null : (
            <p className="rounded-lg border border-[#c71f37]/25 bg-[#c71f37]/5 p-2 text-[13px] text-[#8a1f2a]">
              API status {workspace.status ?? "unavailable"}: {workspace.error}
            </p>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Templates</CardTitle>
            <CardDescription>Quick starts for new issuance configurations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              {templates.map((template) => (
                <div
                  key={template}
                  className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-4 py-3 text-sm"
                >
                  <p className="text-[#1c1c1d] font-medium">{template}</p>
                  <p className="text-[rgba(28,28,29,0.68)]">
                    Select this model to preconfigure a default policy and extension set.
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent</CardTitle>
            <CardDescription>Latest issuances currently tracked in this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {issuances.length === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.72)]">No issuances found yet.</p>
            ) : (
              <div className="space-y-2 text-sm">
                {issuances.slice(0, 4).map((issuance) => {
                  return (
                    <div
                      key={issuance.id}
                      className="rounded-xl border border-[rgba(28,28,29,0.12)] px-4 py-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-[#1c1d1e]">{issuance.name}</p>
                        <span className="rounded-full bg-[rgba(28,28,29,0.08)] px-2 py-0.5 text-xs uppercase tracking-[0.2em]">
                          {normalizeStatus(issuance.status)}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-[rgba(28,28,29,0.68)]">
                        {issuance.template || issuance.type || "custom"} · {issuance.createdAt ?? "Not available"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
