/**
 * SDP API — Cloudflare Workers entrypoint.
 *
 * Thin wrapper around the runtime-neutral `createApp` from `app.ts`. All CF
 * specifics (ExecutionContext, KV / Hyperdrive bindings via `Env`, Sentry CF
 * SDK, `ctx.waitUntil`) live here. The Node entrypoint lands in `server.ts`
 * (HOO-511) and consumes the same `createApp` factory.
 */

import { createApp } from "@/app";
import { runPendingTransfersReconciliation } from "@/cron/pending-transfers";
import { withProcessEnvFallback } from "@/lib/runtime-env";
import { WorkersBackgroundRunner } from "@/runtime/background-cf";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { cloudflareObservability, withSentry } from "@/runtime/observability-cf";
import type { Env } from "@/types/env";

const app = createApp({ observability: cloudflareObservability });

const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, withProcessEnvFallback(env), ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const runtimeEnv = withProcessEnvFallback(env);
    runPendingTransfersReconciliation({
      env: runtimeEnv,
      bg: new WorkersBackgroundRunner(ctx),
      observability: isSentryEnabled(runtimeEnv) ? cloudflareObservability : undefined,
    });
  },
  request(
    input: RequestInfo | URL,
    init?: RequestInit,
    env?: Env | Record<string, unknown>,
    executionCtx?: ExecutionContext
  ) {
    if (!env) {
      return app.request(input, init, env, executionCtx);
    }

    return app.request(input, init, withProcessEnvFallback(env as Env), executionCtx);
  },
} satisfies ExportedHandler<Env> & {
  request: typeof app.request;
};

export default withSentry(getSentryOptions, worker);
