# Solana Developer Platform

Solana Developer Platform gives organizations project-scoped access to tokenization, custody, payments, RPC, and compliance capabilities.

## Language

**Provider Availability**:
Whether an **Organization** can use a **Provider** in a **Provider Family** in the current deployment environment.
_Avoid_: Runtime health, selected provider, project setup

**Private Transfer**:
A **Payment Transfer** whose transaction is built by a private-transfer **Provider** and executed through provider-specific routing metadata before final settlement.
_Avoid_: Confidential transfer, shielded transfer

**Counterparty Account**:
A payment destination or payout instrument owned by a **Counterparty**. A Solana crypto-wallet **Counterparty Account** stores the recipient wallet owner address; token accounts are derived during payment execution.
_Avoid_: Custody wallet, token account, provider account data

**Recurring Payment**:
A payments product flow that repeatedly sends a fixed SPL token amount from an SDP custody source wallet to a **Counterparty Account** on a configured period. Activation and collection are executed server-side for the SDP-custody source wallet.
_Avoid_: Low-level subscription record, billing plan template, native SOL transfer

**Collection Attempt**:
An execution attempt for a due **Recurring Payment**. A confirmed **Collection Attempt** is linked to a **Payment Transfer** and advances the next due collection time.
_Avoid_: Cron job, payment intent, transaction signature

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.
- A **Private Transfer** is still a **Payment Transfer**; privacy changes how the transfer is prepared and submitted, not the wallet permission model.
- A **Counterparty** may have one or more **Counterparty Accounts**.
- A **Recurring Payment** pays a **Counterparty Account** from an SDP custody source wallet.
- A **Recurring Payment** produces one **Collection Attempt** for each due collection time.
- A confirmed **Collection Attempt** creates or links to one outbound **Payment Transfer**.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "No. A provider is available only when the organization is entitled to it and the deployment environment is configured for it."

## Flagged Ambiguities

- "Available" can mean entitlement, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means entitlement plus deployment configuration only.
