/**
 * Base58 Solana public key shape, shared by every Markets surface that reads
 * one from free text: 32-44 characters from the alphabet that excludes 0, O,
 * I and l so they cannot be confused when read aloud. Shape only — every
 * consumer re-validates with a real decoder before money moves.
 */
export const BASE58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
