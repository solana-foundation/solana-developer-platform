// Verifies a plan's transaction in the browser with `@sdp/intents-verifier`. It reads the surfnet
// through the dev server's `/rpc`, so the service that planned the transaction takes no part.

import { type VerifiedTransaction, Verifier } from "@sdp/intents-verifier";

import type { Plan } from "@/api";

/// What the verifier compares: the message that the service says the transaction proves.
interface Planned {
  message: string;
}

export interface Verified extends VerifiedTransaction {
  /// Whether the transaction proves the message that the plan shows.
  matches: boolean;
}

const RPC = "/rpc";

let loading: Promise<Verifier> | null = null;

/// The module loads on the first verify, so a page with no built module still runs.
function verifier(): Promise<Verifier> {
  loading ??= import("@sdp/intents-verifier/verifier.wasm?url")
    .then((module) => Verifier.load(module.default))
    .catch((error: unknown) => {
      loading = null;
      throw new Error(
        `The verifier module does not load. Build it with \`pnpm --filter @sdp/intents-verifier build:wasm\`.\n\n${error}`
      );
    });

  return loading;
}

export async function verifyPlan(plan: Planned, transaction: NonNullable<Plan["transaction"]>) {
  const message = Uint8Array.from(atob(transaction.messageBytes), (character) =>
    character.charCodeAt(0)
  );
  const verified = await (await verifier()).verifyMessage(message, RPC);

  return { ...verified, matches: verified.message === plan.message } satisfies Verified;
}
