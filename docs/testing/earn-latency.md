# Earn latency checks (PRO-2578)

These checks cover scheduling, request budgets and balance freshness on top of
main `c65066528`. They do not measure live signing, provider settlement or a
signed-in browser. The local PostgreSQL and Redis instances are disposable;
chain and provider responses are simulated.

- Operation pickup: 16 accepted operations reached their fenced worker claim
  in 28.40 ms median and 34.49 ms p95/max. The controlled-clock comparison
  places acceptance just after a tick: 14,999 ms previously, zero timer delay
  with notifications, and 1,999 ms with a lost notification.
- Missing-settlement backlog: 1,000 unavailable IDs retire after 30 requests,
  capped at 100 IDs each. Stale feed refreshes cannot reset their retry budget.
- UI budget: with 500 pending activity rows mounted, the foreground completion
  reaches the cache within one second using one status request. Passive rows add
  no individual timers. A 350-row disappearing backlog drains in four requests
  capped at 100 IDs each.
- Projection budget: 50 direct operations or 50 queued requests need two DB
  reads instead of 100, with equivalent results. A mixed page needs three.
  Validating 100 balance proofs also drops from 100 serial DB reads to one;
  signature observation remains one shared RPC read.
- Refresh budget: affected positions and wallets refresh together; 120
  successive actions keep at most two movement proofs in each detail request
  and one retained proof in the next portfolio read.
  In the two-wallet fixture, refreshing one affected wallet drops from three
  HTTP requests (inventory and both balances) to one balance request.
- Recovery backlog: 256 movements or 128 queued actions use one status request
  per batch. Twelve expired rows spanning three processing groups share one
  finalized height and one corroborating status read per endpoint per sweep.
  Repeating the movement sweep reads again; evidence does not survive between
  invocations.
- Backlog isolation: no rows are leased while the shared RPC waits. With four
  provider reads blocked, the fast observer still advances later work and a
  newly submitted movement or queued action. Competing workers take disjoint
  four-row claims. With four fast-observer projections blocked, null-status
  direct and queued transactions stay unleased and both recovery paths
  rebroadcast their original bytes. This uses the existing three status reads
  (observer, movement recovery and queued recovery). Changed absence markers or
  signed bytes cannot reuse earlier recovery evidence.

The competing-observer burst processes 129 finalized movements with three
status reads. It took 70 ms locally and 201 ms during a concurrent test run;
these mocked-chain results establish bounded draining, not a production SLA.

Provider approval and asynchronous redemption waits remain explicit operation
states. Live Treasury/Embedded Yield timings, preparation/initial-loading
profiles and deployment-scale load measurements remain PRO-2578 acceptance
work; these local results do not close that ticket.
