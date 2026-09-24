# Documentation Style Guide

This guide sets the writing rules for every page in `apps/sdp-docs/content/docs` and for the
`description` and `summary` strings in `apps/sdp-api/src/openapi`.

The rules are adapted from [ASD-STE100 Simplified Technical English][ste], the controlled-English
standard used for aviation maintenance manuals. SDP readers are not all native English speakers,
and many of them read these pages next to a regulator, an auditor, or a translation tool. Short
sentences and one meaning per word make the pages easier to read, easier to translate, and easier
for an agent to quote without distorting them.

The guide is prescriptive on purpose. When a rule and a sentence disagree, change the sentence.

[ste]: https://www.asd-ste100.org/

## The nine rules

### 1. Keep sentences short

- Instructions: 20 words or fewer.
- Descriptions and explanations: 25 words or fewer.
- Never run two ideas together with a semicolon, a dash, or "and so".

A sentence over 25 words is almost always two sentences, or a sentence and a table row.

Before:

> The `sourceCustodyWalletId` field is the exact SDP Wallet `id` (`cwlt_…`, from `GET /v1/wallets`),
> resolved server-side from the caller's custody-wallet list; `destination` is the recipient's
> on-chain **wallet (owner) address** — for SPL transfers, SDP derives the associated token account
> (ATA) from this address and creates it if needed, so pass the wallet pubkey, **not** a
> token-account address.

After:

> `sourceCustodyWalletId` is the SDP wallet `id` (`cwlt_…`). `GET /v1/wallets` returns it.
>
> `destination` is the recipient's wallet address, also called the owner address. For SPL token
> transfers, SDP derives the associated token account from this address. SDP creates that account
> if it does not exist.
>
> Pass the wallet address. Do not pass a token account address.

### 2. One instruction per sentence

Write each action as its own sentence. Write a sequence of actions as a numbered list.

Before:

> Fill in the amount and optional memo, then click **Mint tokens**.

After:

> 1. Enter the amount.
> 2. Enter a memo. This field is optional.
> 3. Select **Mint tokens**.

### 3. Use the active voice

Name the actor. The actor is usually you, SDP, the provider, or the network.

| Do not write | Write |
| --- | --- |
| The transaction is signed by the custody provider. | The custody provider signs the transaction. |
| Memos are persisted on the transfer record. | SDP stores the memo on the transfer record. |
| Wallets must be provisioned first. | Create the wallet first. |

Passive voice is allowed when the actor is genuinely unknown or irrelevant, such as
"the account was frozen before SDP received the request".

### 4. Use simple tenses

Use the present tense for behavior and the imperative for instructions. Avoid "will", "would",
"has been", and "is being".

| Do not write | Write |
| --- | --- |
| The response will contain a signature. | The response contains a signature. |
| Once the transfer has been confirmed… | When the transfer is `confirmed`… |

### 5. Use verbs, not nominalizations

A hidden verb makes a sentence longer and vaguer.

| Do not write | Write |
| --- | --- |
| perform a validation of | validate |
| provide support for | support |
| make a determination | decide |
| is a requirement for | requires |
| gives you the ability to | lets you |

### 6. One word, one meaning

Pick one term per concept and use only that term. The approved terms are listed below. Do not
introduce a synonym for variety; variety is a defect in technical writing.

Avoid words that mean different things in different sentences. The worst offender in these docs is
**surface**, used as a verb ("memos surface in list responses"), as a noun for an API area ("the
public surface"), and as a noun for a screen. Use **appear**, **API area**, and **page**.

### 7. No jargon, metaphor, or idiom

| Do not write | Write |
| --- | --- |
| rails | network, or payment route |
| building blocks, primitives | parts, or name the parts |
| under the hood | internally, or name the component |
| on the wire | in the request body, in the response |
| stitch together, wire up | connect, configure |
| spin up, stand up | start, create |
| out of the box, turnkey | by default, with no extra configuration |
| unlock, leverage, utilize | use, enable |
| seamless, powerful, robust | delete the word, or state the measurable property |
| simply, just, of course, easily | delete the word |
| heavy lifting | delete the clause |

Delete "simply", "just", and "easily" without a replacement. They tell a stuck reader that their
problem is their own fault.

### 8. Keep noun stacks to two nouns

Three or more nouns in a row force the reader to guess which noun modifies which.

| Do not write | Write |
| --- | --- |
| counterparty account requirement schema | the schema for counterparty account requirements |
| provider requirements onboarding flow | the onboarding flow for provider requirements |
| wallet policy evaluation history | the evaluation history for a wallet policy |

Product names that are already two nouns, such as **custody wallet** and **payment request**, count
as one term.

### 9. Keep the small words

Keep "the", "a", "that", and "which". They cost one word and save a re-read.

| Do not write | Write |
| --- | --- |
| Set flag to enable feature. | Set the flag to enable the feature. |
| Note transfer can fail. | Note that the transfer can fail. |

## Punctuation

- Use a period. Split the sentence instead of using a semicolon.
- Use an em dash only for a genuine aside, at most once per paragraph. Do not use an em dash as a
  comma or a colon. Most em dashes in a draft should become periods.
- Use a colon to introduce a list or an example.
- Spell out Latin abbreviations: "for example" not "e.g.", "that is" not "i.e.", "and so on" not
  "etc.". In tables, "for example" still fits.
- Avoid contractions. Write "do not", "does not", "cannot".
- Use a serial comma.

## Structure

- Give every page a `title` and a `description` in the frontmatter. The description is one sentence
  and states what the reader can do after the page.
- Open each page with one or two sentences that say what the page covers. Do not open with history
  or marketing.
- Put prerequisites in a bulleted list before the first step.
- Use a numbered list for a sequence and a bulleted list for a set.
- Use a table when three or more items share the same shape. Do not use a table for two items.
- Keep paragraphs to six sentences or fewer.
- Use sentence case for headings. Write "Create a token", not "Create A Token".
- Make headings verb phrases on procedure pages and noun phrases on reference pages.

## Approved terms

Use the left column. Do not use the alternatives in the right column.

| Approved term | Do not use |
| --- | --- |
| onchain | on-chain, on chain, OnChain |
| offchain | off-chain, off chain |
| the dashboard | the console, the UI, the web app, the platform UI |
| custody wallet | SDP wallet, managed wallet, hosted wallet |
| custody provider | wallet provider, key provider |
| API key | key, token (when the API key is meant) |
| organization | org, tenant |
| project | workspace |
| counterparty | payee, recipient entity |
| counterparty account | payout account, payment method record |
| allowlist | whitelist, allow list, allow-list |
| Token Access Control | the token's allowlist (when the Token-2022 extension is meant) |
| onramp, offramp | on-ramp, off-ramp, on/off-ramp |
| ramp provider | ramp partner, ramp vendor |
| asset rail | rail, corridor rail |
| corridor | route, lane |
| API area | surface, public surface |
| appear, return, include | surface (as a verb) |
| page, screen, tab | surface (as a noun for UI) |
| select | click, tap, press (for a dashboard control) |
| enter | type, input, fill in |
| Solana cluster | network (when devnet or mainnet is meant) |
| devnet, mainnet | dev net, main net, mainnet-beta (in prose) |
| transfer | payment (when the `Transfer` record is meant) |
| mint address | mint, token address (when the address is meant) |

`allowlist` and `Token Access Control` are distinct. `Token Access Control` is the Token-2022
extension on an issued token. `allowlist` is a destination restriction in a wallet policy or an IP
restriction on an API key. Never use one for the other.

## Dashboard instructions

Dashboard pages change more often than the API. Follow these rules so a stale page fails loudly
instead of misleading a reader.

- Name the control in bold and use the exact label: "Select **Create token**."
- Give the route as well as the label when a page is more than two clicks deep.
- Do not describe layout ("in the top right", "the second card"). Layout changes; labels change less
  often.
- State any condition that hides a control. See "Feature flags and environments" below.
- Prefer one screenshot per outcome, not one per click. A screenshot is a checkpoint, not a
  narration.
- Write alt text that states what the reader should verify in the image.

## Feature flags and environments

Not every reader sees every screen. A control can be absent because of a feature flag, a provider
that is not configured, or a Solana cluster that does not support the operation. A page that ignores
this sends the reader looking for a button that cannot exist for them.

- Do not document an API area or a dashboard page that is held back from the public release. The
  public API areas are listed in `AGENTS.md`. Keep unreleased pages in
  `apps/sdp-docs/content/unpublished/`.
- When a feature depends on configuration, state the condition in the prerequisites, and name the
  thing that must be configured.
- When behavior differs between devnet and mainnet, state both in the same paragraph or table row.
- When a provider supports only part of a flow, say which part. Do not describe the full flow and
  leave the reader to discover the gap.
- Write the condition, not the flag name. Write "This page appears after an administrator configures
  a custody provider", not "This page is behind `CUSTODY_ENABLED`". Internal flag names are not part
  of the public documentation.

## Code samples

- Keep the prose and the sample in agreement. If the prose names a field, the sample shows it.
- Use placeholder values that are obviously placeholders: `sk_test_...`, `cwlt_...`, `cp_...`.
- Do not put a real key, address, or customer name in a sample.
- Give every code block a language and, where the file matters, a `title`.
- Explain the sample before the block, not after it.

## What not to edit

These files are generated. Change the source and run the script.

| Generated file | Source | Script |
| --- | --- | --- |
| `apps/sdp-docs/content/docs/reference/api/**` | `apps/sdp-api/src/openapi/**` | `pnpm -C apps/sdp-docs generate:api` |
| `apps/sdp-docs/public/llms.txt`, `llms-full.txt` | docs content and navigation | `pnpm -C apps/sdp-docs generate:ai` |
| `docs/architecture/module-map.md` | module boundaries | `pnpm generate:module-map` |

To change the wording of an API reference page, edit the `description` string in the OpenAPI source
and regenerate. The rules in this guide apply to those strings too.

## Checks

```bash
pnpm --filter sdp-docs check:links
pnpm --filter sdp-docs build
```

`check:links` fails on a link to a page that does not exist. The build fails on invalid MDX and on
an unknown icon name in frontmatter.
