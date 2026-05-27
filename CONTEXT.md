# Solana Developer Platform

Solana Developer Platform gives organizations project-scoped access to tokenization, custody, payments, RPC, and compliance capabilities.

## Language

**Provider Availability**:
Whether an **Organization** can use a **Provider** in a **Provider Family** in the current deployment environment.
_Avoid_: Runtime health, selected provider, project setup

**Private Transfer**:
A **Payment Transfer** whose transaction is built by a private-transfer **Provider** and executed through provider-specific routing metadata before final settlement.
_Avoid_: Confidential transfer, shielded transfer

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.
- A **Private Transfer** is still a **Payment Transfer**; privacy changes how the transfer is prepared and submitted, not the wallet permission model.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "No. A provider is available only when the organization is entitled to it and the deployment environment is configured for it."

## Flagged Ambiguities

- "Available" can mean entitlement, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means entitlement plus deployment configuration only.
