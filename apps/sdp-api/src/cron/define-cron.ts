import type { Env } from "@/types/env";

/**
 * What a Cron Definition does to money (HOO-1955).
 *
 * - `starts`: can sign or pay out something new, so it names how it is admitted
 *   (`lib/money-admission.ts`, or the HTTP pipeline it re-enters), or names the gap until its
 *   module's admission lands.
 * - `finishes`: completes movement already signed or funded, a Money Exit. Its `enabled` is
 *   always true: switching it off would strand money (ADR 0002).
 * - `observes`: reads, reconciles bookkeeping, or cleans up. Moves nothing.
 */
export type CronMoneyEffect =
  | {
      effect: "starts";
      admission: { via: "money_admission" } | { via: "http_pipeline" } | { gap: string };
    }
  | { effect: "finishes" }
  | { effect: "observes" };

/**
 * One named piece of recurring background work, run by the Worker (ADR 0011).
 *
 * - `name` is the stable identity Loki and the sdp-infra alerts match on.
 * - `scope: "cluster"` registers the definition once per Environment, each registration inside
 *   its own cluster scope, so `run` selects only that Environment's rows and reads the chain
 *   through `createClusterRpc()` (ADR 0007). `scope: "global"` registers it once, outside any
 *   cluster scope.
 * - `enabled` is decided once, when the Worker registers the definition.
 * - `runOnStart` also runs one slot as soon as the Worker registers the definition.
 */
export type CronDefinition = CronMoneyEffect & {
  name: string;
  schedule: string;
  scope: "global" | "cluster";
  enabled: (env: Env) => boolean;
  run: (env: Env) => Promise<void>;
  runOnStart?: boolean;
};

/**
 * Declare a Cron Definition. The runner registers it; the definition only says what it is.
 *
 * @param definition - The definition.
 * @returns The same definition.
 */
export function defineCron(definition: CronDefinition): CronDefinition {
  return definition;
}

/** `enabled` for a definition that runs in every deployment. */
export function alwaysEnabled(): boolean {
  return true;
}
