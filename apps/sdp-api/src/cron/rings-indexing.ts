import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { pollRingsIndexing } from "@/services/jobs/poll-rings-indexing";
import { defineCron } from "./define-cron";

// NOTE: classified `observes` for now, while Helius Rings is experimental, knowing it is all
// three: it observes (asks Photon and the chain whether broadcast operations landed), finishes
// (rebroadcasts recorded bytes and completes operations Photon has indexed), and starts (its
// in-flight pass calls `executeOperation`, which rebuilds an operation that died in `proving`,
// has custody sign it and broadcasts a new transaction). One effect cannot say that. Revisit
// before promoting `helius_rings` to the stable release channel: split the starting pass out,
// or classify the cron `starts` (admitted where it signs) or `finishes` (a Money Exit, which
// needs a named security reviewer).
/**
 * Rings indexing poll: settles broadcast Rings operations and resumes in-flight ones. Registered
 * per Environment; only the devnet run does work.
 */
export const ringsIndexingCron = defineCron({
  name: "poll-rings-indexing",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: isHeliusRingsEnabled,
  run: pollRingsIndexing,
});
