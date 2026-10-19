import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import { defineCron } from "./define-cron";

// NOTE: Helius Rings is EXPERIMENTAL and still being worked on. This definition is `global` on
// purpose for now: it reads through the Helius Rings gateway configured from env (devnet only),
// not the shared cluster pool, so it is not cluster-scoped yet. Do not copy this shape for a
// chain-touching cron; use `scope: "cluster"`.
/** Rings indexing poll: builds and signs proving rows. */
export const ringsIndexingCron = defineCron({
  name: "poll-rings-indexing",
  schedule: "* * * * *",
  scope: "global",
  effect: "starts",
  admission: {
    gap: "Helius Rings builds and signs proving rows with no admission; it is devnet-only today, and the Rings slice adds it.",
  },
  enabled: isHeliusRingsEnabled,
  run: pollRingsIndexing,
});
