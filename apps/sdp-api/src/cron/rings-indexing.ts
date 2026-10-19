import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import { defineCron } from "./define-cron";

// NOTE: Helius Rings is EXPERIMENTAL and still being worked on. This definition is `global` on
// purpose for now: it reads through the Helius Rings gateway configured from env (devnet only),
// not the shared cluster pool, so it is not cluster-scoped yet. Do not copy this shape for a
// chain-touching cron; use `scope: "cluster"`.
//
// NOTE: classified `observes` for now, while Helius Rings is experimental, knowing it is all
// three: it observes (asks Photon and the chain whether broadcast operations landed), finishes
// (rebroadcasts recorded bytes and completes operations Photon has indexed), and starts (its
// in-flight pass calls `executeOperation`, which rebuilds an operation that died in `proving`,
// has custody sign it and broadcasts a new transaction). One effect cannot say that. Revisit
// before promoting `helius_rings` to the stable release channel: split the starting pass out,
// or classify the cron `starts` (admitted where it signs) or `finishes` (a Money Exit, which
// needs a named security reviewer).
/** Rings indexing poll: settles broadcast Rings operations and resumes in-flight ones. */
export const ringsIndexingCron = defineCron({
  name: "poll-rings-indexing",
  schedule: "* * * * *",
  scope: "global",
  effect: "observes",
  enabled: isHeliusRingsEnabled,
  run: pollRingsIndexing,
});
