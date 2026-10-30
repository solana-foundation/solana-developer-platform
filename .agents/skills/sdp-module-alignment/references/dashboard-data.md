# Dashboard data checks (C1-C4)

How a module's dashboard reads the API. `web/` = `apps/sdp-web/src/`. The
rules live in `apps/sdp-web/AGENTS.md` and code-standards "Dashboard"; this
file is the checklist.

## C1 Polling shape

- **Condition:** pick one of three shapes per poll:
  - a short watch that stops on its own (a movement settling): pass
    `refreshInterval` as an inline function each render, `(data) =>
    interval(data)`;
  - a poll that never stops: a plain number;
  - a slow poll on a page that re-renders faster than its cadence (discovery
    lists, live feeds with an idle back-off): `useCadencedSWR`
    (`web/lib/use-cadenced-swr.ts`), which hands SWR a number derived from the
    last read so only a cadence change restarts the timer.
- **Never:** a stable function reference as `refreshInterval` (SWR reads a
  function interval only after a tick, so a poll whose first answer is "0"
  never starts after a cold load), a fixed fast poll that runs forever while
  the list is empty, or polling outside SWR with `setInterval` plus
  `router.refresh()` (it re-renders the whole server tree each tick, with no
  dedupe, focus or visibility handling; DvP's trade watch does this every 6 s).
- **Verify:** scanner C1 (named values and numbers passed to
  `refreshInterval`, timers and `router.refresh()`, `+` count of
  `useCadencedSWR`).
- **Earn:** positions every 15 s and three ledgers every 30 s forever, and
  programs that never polled after a hard load; #2574 moved them to
  `useCadencedSWR` with a 120 s idle cadence when empty.

## C2 Keys, batching and fan-out

- **Condition:** SWR keys come from the feature's colocated query-key factory
  (`<feature>-query-key.ts`), never an inline string or array. No hook that
  fires one request per table row: batch in the BFF (Earn's
  `kamino-allocations?vaults=a,b,c` over the existing per-item cache). Layout
  and page share one `cache()`d server read instead of each reading
  onboarding or project state. After a mutation, refresh once at confirmation
  (floored to the confirming slot), not at submit and again at confirm.
- **Verify:** scanner C2 (inline keys); then a request census (C4).
- **Earn:** one Kamino allocations request per row (5 to 1 batched), positions
  read three times in 2 s after one withdrawal, `/v1/onboarding/status` read
  twice per load; all fixed by #2574.

## C3 Focus and revalidation

- **Condition:** data that changes slowly or never during a session turns
  `revalidateOnFocus` (and the other `revalidate*` options) off; focus
  refetches only what a user expects to be fresh.
- **Verify:** scanner C3 lists explicit `revalidateOnFocus: true`; the shared
  default (`web/lib/dashboard-swr-config.ts`) is on, so check hooks that rely
  on it too.

## C4 Measure before and after

- **Condition:** any change to a page's reads states its request counts. Pin
  the page's visibility to visible, then count browser-to-BFF and BFF-to-API
  requests over fixed windows: warm load (first 20 s), idle 300 s, one focus
  event, one mutation. Count chain RPC per API request where the page reads
  chain state (A4).
- **Done:** a before/after table in the PR body and a test that pins the
  post-mutation read count.
- **Earn baseline:** idle Treasury 76 browser requests and 58 API requests per
  5 min before #2574, 21 and 20 after.
