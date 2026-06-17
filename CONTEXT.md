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
A payments product flow that repeatedly sends a fixed SPL token amount from an SDP custody source wallet to a **Counterparty Account** on a configured period. Initial records are created as pending activation; execution endpoints add the on-chain lifecycle.
_Avoid_: Low-level subscription record, billing plan template, native SOL transfer

**Payment Request**:
A payments v2 product flow that asks a payer to complete a payment through a Solana Pay payload or a hosted payment link.
_Avoid_: Wallet Operation Envelope, Payment Transfer, generic email

**Transactional Email**:
An SDP-owned outbound message for a product workflow.
_Avoid_: Raw email, Clerk organization invitation, generic notification

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.
- A **Private Transfer** is still a **Payment Transfer**; privacy changes how the transfer is prepared and submitted, not the wallet permission model.
- A **Counterparty** may have one or more **Counterparty Accounts**.
- A **Recurring Payment** pays a **Counterparty Account** from an SDP custody source wallet.
- A **Payment Request** may be delivered by email, but the email is not the **Payment Request**.
- A **Transactional Email** may deliver a **Payment Request**, but does not own payment lifecycle or settlement matching.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "No. A provider is available only when the organization is entitled to it and the deployment environment is configured for it."

## Flagged Ambiguities

- "Available" can mean entitlement, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means entitlement plus deployment configuration only.
- "Payment request" can mean a low-level request payload or a payer-facing payments product; resolved: use **Payment Request** only for the payments v2 payer-facing flow.
- "Email" can mean Clerk-owned organization invitation delivery or SDP-owned **Transactional Email**; resolved: only **Transactional Email** is owned by SDP.
