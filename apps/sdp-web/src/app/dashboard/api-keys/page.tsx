import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { sdpApiFetch } from "@/lib/sdp-api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { consumeApiKeyFlash, rotateApiKeyAction } from "./actions";
import { DeleteApiKeyModal } from "./delete-api-key-modal";
import { FlashClearTrigger } from "./flash-clear-trigger";
import { GeneratedApiKeyModal } from "./generated-key-modal";

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
  return date.toLocaleString();
}

export default async function ApiKeysPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const [flash, apiKeysResponse] = await Promise.all([
    consumeApiKeyFlash(),
    sdpApiFetch<{ apiKeys: ApiKeyRecord[] }>("/v1/api-keys"),
  ]);

  const apiKeys = [...apiKeysResponse.apiKeys].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const hasGeneratedKeyFlash = Boolean(flash?.key);

  return (
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
              className={flash.level === "error" ? "border-[#c71f37]/25" : "border-[#1c1c1d]/12"}
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
        </CardHeader>
        <CardContent>
          <div className="mb-4 rounded-[10px] border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
            <p className="text-xs text-[rgba(28,28,29,0.72)]">
              Rotation hint: rotate active keys only, use a grace period between 0 and 168 hours,
              and keep old key secrets secure. New key secrets are shown once.
            </p>
          </div>
          {apiKeys.length === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.72)]">No API keys found.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Prefix</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Env</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map((key) => {
                    const canRotate = key.status === "active";

                    return (
                      <TableRow key={key.id}>
                        <TableCell className="font-medium">{key.name}</TableCell>
                        <TableCell className="font-mono text-xs">{key.keyPrefix}</TableCell>
                        <TableCell>{key.role}</TableCell>
                        <TableCell>{key.environment}</TableCell>
                        <TableCell>{key.status}</TableCell>
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
                          <div className="flex items-center justify-end gap-2">
                            {canRotate ? (
                              <form
                                action={rotateApiKeyAction}
                                className="inline-flex items-center justify-end gap-2"
                              >
                                <input type="hidden" name="keyId" value={key.id} />
                                <Input
                                  type="number"
                                  name="grace"
                                  min={0}
                                  max={168}
                                  defaultValue={24}
                                  className="h-8 w-[88px] text-xs"
                                  aria-label={`Grace period hours for ${key.name}`}
                                />
                                <Button type="submit" size="sm" variant="secondary">
                                  Rotate
                                </Button>
                              </form>
                            ) : (
                              <span className="text-xs text-[rgba(28,28,29,0.48)]">
                                Unavailable
                              </span>
                            )}
                            <DeleteApiKeyModal keyId={key.id} keyName={key.name} />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
