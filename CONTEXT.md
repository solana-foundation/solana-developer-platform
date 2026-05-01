# Solana Developer Platform

Solana Developer Platform gives organizations project-scoped access to tokenization, custody, payments, RPC, and compliance capabilities.

## Language

**Provider Availability**:
Whether an **Organization** can use a **Provider** in a **Provider Family** in the current deployment environment.
_Avoid_: Runtime health, selected provider, project setup

## Relationships

- An **Organization** has **Provider Availability** for each **Provider** in each **Provider Family**.
- **Provider Availability** is distinct from provider runtime health.
- **Provider Availability** is distinct from whether a **Project** has selected or initialized a **Provider**.

## Example Dialogue

> **Dev:** "MoonPay is configured in the environment, so is it available for every organization?"
> **Domain expert:** "No. A provider is available only when the organization is entitled to it and the deployment environment is configured for it."

## Flagged Ambiguities

- "Available" can mean entitlement, environment configuration, runtime health, or project setup; resolved: **Provider Availability** means entitlement plus deployment configuration only.
