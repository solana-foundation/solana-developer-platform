import { DashboardHeader } from "@/components/dashboard-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { consumeApiKeyFlash, createApiKeyAction, rotateApiKeyAction } from "./actions";

type ApiKeyRole = "api_admin" | "api_developer" | "api_readonly";
type ApiKeyEnvironment = "sandbox" | "production";
type ApiKeyStatus = "active" | "revoked" | "expired";

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

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <DashboardHeader title="API keys" />

      {flash ? (
        <Card className={flash.level === "error" ? "border-[#c71f37]/25" : "border-[#1c1c1d]/12"}>
          <CardHeader>
            <CardTitle>{flash.level === "error" ? "Action failed" : "Key ready"}</CardTitle>
            <CardDescription>{flash.message}</CardDescription>
          </CardHeader>
          {flash.key ? (
            <CardContent className="space-y-2">
              <Label htmlFor="generated-key">One-time secret key</Label>
              <Input
                id="generated-key"
                readOnly
                value={flash.key}
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="text-xs text-[rgba(28,28,29,0.72)]">
                Store this key securely now. SDP only shows it once.
              </p>
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Create API key</CardTitle>
            <CardDescription>
              Generate an organization key for sandbox or production usage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createApiKeyAction} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" placeholder="CI deploy key" required />
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="role">Role</Label>
                  <select
                    id="role"
                    name="role"
                    defaultValue="api_developer"
                    className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                  >
                    <option value="api_admin">Admin</option>
                    <option value="api_developer">Developer</option>
                    <option value="api_readonly">Read only</option>
                  </select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="environment">Environment</Label>
                  <select
                    id="environment"
                    name="environment"
                    defaultValue="sandbox"
                    className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                  >
                    <option value="sandbox">Sandbox</option>
                    <option value="production">Production</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="expiresAt">Expiration (optional)</Label>
                <Input id="expiresAt" name="expiresAt" type="datetime-local" />
              </div>

              <Button type="submit">Generate key</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rotation</CardTitle>
            <CardDescription>
              Rotate active keys and keep the old key valid during a grace period.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-[rgba(28,28,29,0.74)]">
            <p>Use rotation when key material may be exposed or as part of scheduled key hygiene.</p>
            <p>Grace period must be between 0 and 168 hours.</p>
            <p>Only active keys can be rotated.</p>
            <p>New key secrets are shown once after each rotation.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Existing API keys</CardTitle>
          <CardDescription>Manage key lifecycle for your organization.</CardDescription>
        </CardHeader>
        <CardContent>
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
                    <TableHead className="text-right">Rotate</TableHead>
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
                            <span className="text-xs text-[rgba(28,28,29,0.48)]">Unavailable</span>
                          )}
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
