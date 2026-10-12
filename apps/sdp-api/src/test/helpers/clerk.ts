import assert from "node:assert/strict";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import type { afterAll } from "vitest";
import { getCurrentTest } from "vitest/suite";
import type { DatabaseClient } from "@/db";
import type { Env } from "@/types/env";

const kid = "clerk_test_rs256";

async function startIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwks = JSON.stringify({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }],
  });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(jwks);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const issuer = `http://127.0.0.1:${address.port}`;
  return { issuer, jwksUrl: `${issuer}/.well-known/jwks.json`, privateKey, server };
}

let issuerPromise: ReturnType<typeof startIssuer> | undefined;

/**
 * Registers the global Vitest afterAll hook when exposed outside a running test.
 * Otherwise the unreferenced server lives until process exit.
 */
export async function ensureTestClerkIssuer(
  env: Env
): Promise<{ issuer: string; jwksUrl: string }> {
  if (issuerPromise === undefined) {
    const started = startIssuer();
    issuerPromise = started;
    const hook = (globalThis as { afterAll?: typeof afterAll }).afterAll;
    if (typeof hook === "function" && getCurrentTest() === undefined) {
      hook(async () => {
        const { server } = await started;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      });
    }
  }

  const { issuer, jwksUrl } = await issuerPromise;
  env.CLERK_ISSUER = issuer;
  env.CLERK_JWKS_URL = jwksUrl;
  return { issuer, jwksUrl };
}

export async function signTestClerkClaims(
  payload: JWTPayload,
  expiresInSeconds: number
): Promise<string> {
  assert(issuerPromise !== undefined, "Call ensureTestClerkIssuer before signing a token");
  const { issuer, privateKey } = await issuerPromise;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(privateKey);
}

export async function signTestClerkJwt(input: {
  clerkUserId: string;
  clerkOrgId: string;
  orgRole: "admin" | "member";
  orgSlug: string;
  email: string;
  expiresInSeconds: number;
}): Promise<string> {
  assert(issuerPromise !== undefined, "Call ensureTestClerkIssuer before signing a token");
  const { issuer, privateKey } = await issuerPromise;
  return new SignJWT({
    v: 2,
    o: { id: input.clerkOrgId, rol: input.orgRole, slg: input.orgSlug },
    email: input.email,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setSubject(input.clerkUserId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + input.expiresInSeconds)
    .sign(privateKey);
}

interface ClerkIdentityInput {
  userId: string;
  email: string;
  clerkUserId: string;
  organizationId: string;
  clerkOrgId: string;
  orgSlug: string;
  role: "admin" | "member";
}

export async function seedClerkIdentity(db: DatabaseClient, input: ClerkIdentityInput) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
       VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind(`aui_test_${input.clerkUserId}`, input.clerkUserId, input.userId, input.email),
    db
      .prepare(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
       VALUES (?, 'clerk', ?, ?, ?)
       ON CONFLICT (provider, provider_org_id) DO UPDATE
       SET organization_id = EXCLUDED.organization_id, slug = EXCLUDED.slug`
      )
      .bind(`aoi_test_${input.clerkOrgId}`, input.clerkOrgId, input.organizationId, input.orgSlug),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        `mem_test_${input.organizationId}_${input.userId}`,
        input.organizationId,
        input.userId,
        input.role
      ),
  ]);
}

export function clerkHeadersWithoutProject(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export function clerkHeaders(token: string, projectId: string): Record<string, string> {
  return { ...clerkHeadersWithoutProject(token), "x-project-id": projectId };
}

export async function authenticateTestClerkUser(
  env: Env,
  db: DatabaseClient,
  input: ClerkIdentityInput
) {
  await ensureTestClerkIssuer(env);
  await seedClerkIdentity(db, input);
  const token = await signTestClerkJwt({
    clerkUserId: input.clerkUserId,
    clerkOrgId: input.clerkOrgId,
    orgRole: input.role,
    orgSlug: input.orgSlug,
    email: input.email,
    expiresInSeconds: 300,
  });
  return { token, headers: (projectId: string) => clerkHeaders(token, projectId) };
}
