# Ground RWA coverage — findings against the Earn V1 product doc

Investigation record for [PRO-1638](https://linear.app/solana-fndn/issue/PRO-1638).
Companion data: [ground-catalogue-inventory.md](./ground-catalogue-inventory.md)
(auto-generated; refresh with `pnpm --filter @sdp/api earn:inventory`).

**Status: Solana-only gate shipped 2026-08-12 (see "Where these sources live"
below). Sandbox re-inventoried 2026-08-12. Production inventory pending** — it
requires `GROUND_API_KEY` from an approved environment (never a laptop;
`packages/sdp-earn/CLAUDE.md`: provider sandbox only), or Ground answering the
questions below directly. Sandbox is the best proxy observable today, and
everything below should be re-read against the production run when it lands.

## What was measured

The raw, unfiltered `GET /v2/wallets/yield-sources` catalogue, distilled with
the **same `distillGroundYieldSource` the hourly catalogue sync uses** — so
"catalogued" below is exactly what SDP surfaces, and "dropped" is exactly what
the pipeline's gates silently remove. The product doc names ten candidate RWA
sources (BUIDL, BENJI, SWEEP, OUSG, USDY, BAGEY, USDe, Figure PRIME, Syrup
USDC, AAA CLO) plus two later arrivals (JPM JOLT, BlackRock B-reserves); the
inventory matches each against every raw source, dropped ones included.

## The sandbox picture (2026-08-05)

18 raw sources → **15 catalogued: 4 RWA / 11 DeFi** → 3 dropped (all
`not_solana_routable` USDT twins). The RWA shelf is:

| source | what it is | redemption |
| --- | --- | --- |
| Janus Henderson JAAA | AAA-rated CLOs (tokenized by Centrifuge) | 1–2 banking days |
| Janus Henderson JTRSY | short-duration US Treasuries (Centrifuge) | 1–2 banking days |
| Invesco USTB | short-duration US Treasury Bills (Superstate) | 7200s (~2 hours) |
| Bitwise Crypto Carry Fund | crypto cash-and-carry + Treasuries (Superstate) | 1–2 banking days |

All four take USDC, all classify `rwa`, and all attribute to a mapped dashboard
label. Note USTB redeems on an **elapsed-seconds** basis, not banking days —
the catalogue rounds it up to the T+1 the dashboard shows, so the displayed
term is conservative rather than exact.

**This is a single measurement, not a trend.** The dev seed's 10 fixtures
(2 `rwa`) are a hand-picked spread chosen to exercise the dashboard — the
script says so itself — not a snapshot of the 2026-08-04 catalogue, so nothing
here supports a claim that coverage grew or is improving. Establishing
direction needs a second inventory run; the committed snapshot exists to make
that comparison possible from now on. What can be said today is the level: a
shelf of treasuries plus one CLO fund and one carry fund, and none of the
marquee issuer names the doc leads with.

## Where these sources live — and why it IS now a filter

**Resolved 2026-08-12: SDP lists and stores Solana-HOSTED vaults only.** Of the
15 sources this shelf used to carry, only 5 are hosted on Solana — all Kamino,
all DeFi — and every one of the 4 RWA sources sat on Ethereum, as did Morpho,
Aave and Syrup.

The earlier reading (recorded below for provenance) was that SDP's Solana-only
mandate governed the rails the **customer** touches — they send USDC to a Solana
address and are paid out to one — while Ground routes capital onward internally
(the `bridge` position kind), so a source hosted off Solana but funded by Solana
USDC was catalogued on purpose. That is no longer the platform's behaviour:
"Solana Earn" means Solana-hosted yield, not Solana-rail access to yield hosted
elsewhere, and the `not_solana_hosted` gate in `distillGroundYieldSource`
enforces it for both listing and storage.

The price is the one this document priced in advance, and it has been paid
deliberately: **RWA coverage is now zero** and the shelf is five sources,
all Kamino, all DeFi. The catalogue sync additionally DELETES rows that stop
qualifying, so the 10 Ethereum-hosted rows already stored in every environment
are removed on the next pass rather than lingering as depositable strategies.

Two consequences worth carrying forward:

- **The product doc's RWA story has no day-one shelf.** JAAA, JTRSY, USTB and
  USCC are all Ethereum-hosted and now dropped. The nearest Solana-native
  RWA-adjacent exposure is `kamino-rockawayx-rwa-usdc` (OnRe, Huma, Obligate and
  Figure sleeves) and `kamino-superstate-usdc`, both of which classify `defi`
  because Ground types their sleeves as Kamino `reserve`s. Whether Ground counts
  those as RWA is question 5 below and now decides whether V1 has any RWA claim
  at all.
- **Production is unmeasured.** Everything here is sandbox. The gate is keyed on
  the environment's Solana chain (`solana` in production, `solana_devnet` in
  sandbox), so it applies identically — but *how much* of Ground's production
  shelf is Solana-hosted is unknown until the production inventory runs.

## Delta against the doc's named RWA list

- **Present and correct:** AAA CLO — that is JAAA, catalogued as `rwa`.
- **Present but classifies `defi`:** Syrup USDC. Ground types its sleeves
  `loan`/`liquidity`, so dominant-allocation classification calls it DeFi.
  The doc counts Maple's private-credit pools toward the RWA story; the
  platform will not. Whichever way that argument lands, the doc and the
  catalogue currently disagree in a customer-visible way.
- **Absent from sandbox entirely (8 of 10):** BUIDL, BENJI, SWEEP, OUSG,
  USDY, BAGEY, USDe, Figure PRIME — and both later arrivals (JOLT,
  B-reserves). Nothing suggests any of them is hiding behind a filter: the
  only dropped sources are USDT twins of products whose USDC variants are
  catalogued.

## What the filters cost (the "silently shrunk" question)

Today's gates cost **zero RWA coverage in sandbox**: the three drops are
`active` USDT variants (JAAA-USDT, JTRSY-USDT, Syrup USDT) whose USDC twins
are catalogued, and Ground's Solana rails carry USDC only, so those variants
are un-fundable and un-exitable through SDP regardless. Two structural
observations for the production run:

- A production RWA source offered **only** in USDT would be invisible to SDP.
  The dropped-sources table is where that would show up — check it.
- No `buy_only`/`sell_only`/`emergency_freeze` sources existed in sandbox at
  inventory time, so the fund-trapping gate cost nothing here; that can differ
  in production and over time.

## Classification and attribution checks (acceptance criteria)

- **RWA sources classify `rwa`:** yes, 4/4 — each reports a single 100%
  allocation typed `rwa` or `treasury`, both matched by `RWA_ALLOCATION_TYPE`.
  The allocation-type census confirms Ground still emits only the six `type`
  values the classifier was calibrated on (`market`, `liquidity`, `loan`,
  `reserve`, `rwa`, `treasury`).
- **Curator attribution in the dashboard:** correct for every catalogued
  source. The two Superstate vaults derive Ground's wrapper ids
  (`gustb`/`guscc`) and the display registry maps them to "Superstate USTB" /
  "Superstate USCC" — deliberate, per `EARN_KNOWN_CURATOR_LABELS`, and more
  precise than a bare "Superstate".
- **One genuine ambiguity:** `kamino-rockawayx-rwa-usdc` is *named* RWA but
  classifies `defi`, because Ground types all seven of its sleeves as Kamino
  `reserve`s. Those reserves carry OnRe (40.57% + 1.10%), Huma (30.00%),
  Obligate (18.33%) and Figure (10.00%), with Solstice and a third OnRe sleeve
  at 0% — private-credit and insurance-adjacent protocols, so the name is not
  obviously wrong; the allocation typing just doesn't carry the information.
  Same shape as the Syrup question: **is Ground's allocation `type` the
  authority on RWA-ness, or does SDP need issuer-level truth?**
- Side note for the epic text: it attributes JAAA to Maple; Ground reports
  `protocol: centrifuge` for both Janus Henderson vaults.

## Questions for Ground

1. Does the **production** catalogue match sandbox today (18 sources, 4 RWA)?
   If it differs, in which direction?
2. The Earn V1 doc names BUIDL, BENJI, SWEEP, OUSG, USDY, BAGEY, USDe and
   Figure PRIME. Can Ground source any of them, and on what timeline relative
   to 2026-11-15? Same for JPM JOLT and BlackRock B-reserves as later
   arrivals.
3. Are any production sources offered in USDT only, or in `buy_only` mode?
   (Both are invisible to SDP's catalogue by design.)
4. Is the allocation `type` vocabulary (`market`, `liquidity`, `loan`,
   `reserve`, `rwa`, `treasury`) stable and documented? SDP classifies RWA
   from it; a new type or a re-typing changes our catalogue split.
5. Should Kamino RockawayX RWA (Solstice/Huma/OnRe reserves) and Maple's
   Syrup pools be considered RWA exposure in Ground's own taxonomy? Their
   current typing says no.

## Implications for the V1 promise

If production mirrors sandbox, V1 launches with **four RWA sources — two
treasury funds, one CLO fund, one carry fund — versus the ten issuer names
the doc leads with**, on a shelf that is majority DeFi (4:11). That is a real
product-messaging gap but not the "mostly-DeFi product" worst case: the
treasury/CLO shelf is credible RWA exposure. The epic and product doc
should state the actual day-one RWA list once the production inventory (or
Ground's answer to question 1) confirms it — that update is the last
acceptance criterion of PRO-1638 and deliberately waits for production truth.
