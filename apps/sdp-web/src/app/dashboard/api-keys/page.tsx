import { PageBody, PageHeader, PageLayout } from "@/components/layouts";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createSdpApiClient, sdpApiFetch } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import type { PaymentsDashboardWallet } from "@sdp/types";
import { redirect } from "next/navigation";
import { fetchPaymentsWallets } from "../payments/payments-page.data";
import { consumeApiKeyFlash } from "./actions";
import { ApiKeyActionsMenu } from "./api-key-actions-menu";
import { CreateApiKeyModal } from "./create-api-key-modal";
import { FlashClearTrigger } from "./flash-clear-trigger";
import { GeneratedApiKeyModal } from "./generated-key-modal";

export const dynamic = "force-dynamic";

type ApiKeyRole = "api_admin" | "api_developer" | "api_readonly";
type ApiKeyEnvironment = "sandbox" | "production";
type ApiKeyStatus = "active" | "revoked" | "expired" | "deactivated";

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatRole(role: ApiKeyRole): string {
  if (role === "api_admin") return "Admin";
  if (role === "api_readonly") return "Read only";
  return "Developer";
}

export default async function ApiKeysPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const apiClient = await createSdpApiClient();
  const [flash, apiKeysResponse, walletsResponse] = await Promise.all([
    consumeApiKeyFlash(),
    sdpApiFetch<{ apiKeys: ApiKeyRecord[] }>("/v1/api-keys"),
    fetchPaymentsWallets(apiClient.request),
  ]);

  const apiKeys = [...apiKeysResponse.apiKeys].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const hasGeneratedKeyFlash = Boolean(flash?.key);
  const wallets: PaymentsDashboardWallet[] = walletsResponse.ok ? (walletsResponse.data ?? []) : [];

  return (
    <PageLayout width="full">
      <PageHeader variant="wide" title="API keys" />
      <PageBody>
        <div className="w-full flex flex-col gap-6">
          {flash ? (
            <>
              {!hasGeneratedKeyFlash ? <FlashClearTrigger /> : null}
              {hasGeneratedKeyFlash ? (
                <GeneratedApiKeyModal
                  keyValue={flash.key ?? ""}
                  message={flash.message}
                  keyPrefix={flash.keyPrefix}
                />
              ) : (
                <Card
                  className={
                    flash.level === "error" ? "border-[#c71f37]/25" : "border-[#1c1c1d]/12"
                  }
                >
                  <CardHeader>
                    <CardTitle>{flash.level === "error" ? "Action failed" : "Notice"}</CardTitle>
                    <CardDescription>{flash.message}</CardDescription>
                  </CardHeader>
                </Card>
              )}
            </>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Existing API keys</CardTitle>
              <CardDescription>Active and historical keys for this workspace.</CardDescription>
              <CardAction>
                <CreateApiKeyModal triggerLabel="New API key" wallets={wallets} />
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
                <p className="text-xs text-[rgba(28,28,29,0.72)]">
                  Rotation hint: rotate active keys only. The dashboard uses a 24-hour grace period;
                  use the API for custom grace values (0-168h). New key secrets are shown once.
                </p>
              </div>
              {apiKeys.length === 0 ? (
                <p className="text-sm text-[rgba(28,28,29,0.72)]">No API keys found.</p>
              ) : (
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[14%]">Name</TableHead>
                      <TableHead className="w-[14%]">Prefix</TableHead>
                      <TableHead className="w-[10%]">Role</TableHead>
                      <TableHead className="w-[8%]">Env</TableHead>
                      <TableHead className="w-[10%]">Status</TableHead>
                      <TableHead className="w-[11%]">Last used</TableHead>
                      <TableHead className="w-[11%]">Expires</TableHead>
                      <TableHead className="w-[11%]">Created</TableHead>
                      <TableHead className="w-[21%] text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apiKeys.map((key) => {
                      const canRotate = key.status === "active";

                      return (
                        <TableRow key={key.id}>
                          <TableCell className="font-medium">
                            <span className="block truncate">{key.name}</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            <span className="block truncate">{key.keyPrefix}</span>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="block truncate">{formatRole(key.role)}</span>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="block truncate">{key.environment}</span>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span className="block truncate">{key.status}</span>
                          </TableCell>
                          <TableCell className="text-xs text-[rgba(28,28,29,0.72)]">
                            {formatDate(key.lastUsedAt)}
                          </TableCell>
                          <TableCell className="text-xs text-[rgba(28,28,29,0.72)]">
                            {formatDate(key.expiresAt)}
                          </TableCell>
                          <TableCell className="text-xs text-[rgba(28,28,29,0.72)]">
                            {formatDate(key.createdAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            <ApiKeyActionsMenu
                              keyId={key.id}
                              keyName={key.name}
                              canRotate={canRotate}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </PageLayout>
  );
}
