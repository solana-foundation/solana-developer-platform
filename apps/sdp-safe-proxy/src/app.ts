import { createHash, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { SignJWT } from "jose";
import { matchEndpoint } from "./endpoints/match";
import { FROM_PROVIDER_HEADER } from "./endpoints/protocol";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "./endpoints/providers";
import { badGateway, forbidden, internal, notFound } from "./errors";
import { type AppEnv, bodyWithinLimit, requestLog } from "./middleware";
import { inReleaseChannel, providerTarget } from "./utils";

export interface ProviderCredentials {
  fireblocks: { apiKey: string; privateKey: CryptoKey } | null;
  privy: { appId: string; appSecret: string } | null;
}

export interface AppDependencies {
  caller: MiddlewareHandler<AppEnv>;
  credentials: ProviderCredentials;
  providerTimeoutMs: number;
}

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use(requestId());

  app.use(requestLog);

  app.all("/:provider/*", bodyWithinLimit, dependencies.caller, async (c) => {
    const line = c.get("line");
    const caller = c.get("caller");
    line.caller = caller;

    const provider = c.req.param("provider");
    const target = providerTarget(c.req.url, provider);
    if (target === null) throw notFound();
    const body = await c.req.text();

    const match = matchEndpoint({ provider, method: c.req.method, path: target, body });
    if (!match.allowed) throw forbidden(match.code);
    const { endpoint } = match;
    line.provider = match.provider;
    line.endpoint = `${endpoint.method} ${endpoint.path}`;

    if (!inReleaseChannel(match.provider)) throw forbidden("provider_not_in_release_channel");
    if (!endpoint.callers.includes(caller)) throw forbidden("caller_not_allowed");

    const headers = new Headers();
    for (const name of endpoint.requestHeaders) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    if (body !== "") headers.set("content-type", "application/json");
    const auth = await authHeaders(match.provider, dependencies.credentials, target, body);
    for (const [name, value] of Object.entries(auth)) headers.set(name, value);

    let answer: Response;
    try {
      answer = await fetch(`https://${SAFE_PROXY_PROVIDERS[match.provider].hosts[0]}${target}`, {
        method: endpoint.method,
        headers,
        body: body === "" ? null : body,
        redirect: "manual",
        signal: AbortSignal.timeout(dependencies.providerTimeoutMs),
      });
    } catch {
      throw badGateway();
    }

    const answerHeaders = new Headers({ [FROM_PROVIDER_HEADER]: "1" });
    const contentType = answer.headers.get("content-type");
    if (contentType !== null) answerHeaders.set("content-type", contentType);
    return new Response(answer.body, { status: answer.status, headers: answerHeaders });
  });

  app.notFound((c) => {
    const error = notFound();
    c.get("line").error = error.message;
    return error.getResponse();
  });

  app.onError((error, c) => {
    c.get("line").error = error instanceof HTTPException ? error.message : error.constructor.name;
    return error instanceof HTTPException ? error.getResponse() : internal().getResponse();
  });

  return app;
}

type FireblocksAuthHeaders = { Authorization: string; "X-API-Key": string };
type PrivyAuthHeaders = { Authorization: string; "privy-app-id": string };

async function authHeaders(
  provider: SafeProxyProvider,
  credentials: ProviderCredentials,
  target: string,
  body: string
): Promise<FireblocksAuthHeaders | PrivyAuthHeaders> {
  switch (provider) {
    case "fireblocks": {
      if (credentials.fireblocks === null) throw new Error("Fireblocks credentials are not loaded");
      const { apiKey, privateKey } = credentials.fireblocks;
      const tokenLifetimeSeconds = 30;
      const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ bodyHash, nonce: randomUUID(), uri: target })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject(apiKey)
        .setIssuedAt(now)
        .setExpirationTime(now + tokenLifetimeSeconds)
        .sign(privateKey);
      return { Authorization: `Bearer ${token}`, "X-API-Key": apiKey };
    }
    case "privy": {
      if (credentials.privy === null) throw new Error("Privy credentials are not loaded");
      const { appId, appSecret } = credentials.privy;
      const basic = Buffer.from(`${appId}:${appSecret}`, "utf8").toString("base64");
      return { Authorization: `Basic ${basic}`, "privy-app-id": appId };
    }
    default: {
      const unreachable: never = provider;
      return unreachable;
    }
  }
}
