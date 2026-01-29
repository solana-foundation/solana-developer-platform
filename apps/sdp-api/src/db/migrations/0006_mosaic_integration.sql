-- Mosaic Integration Schema
-- Migration: 0006_mosaic_integration.sql
--
-- Adds support for Mosaic SDK template-based token deployment:
-- - template: Stores the token template used (stablecoin, rwa, arcade, etc.)
-- - abl_list_address: On-chain ABL (allowlist/blocklist) address created by Mosaic

-- ═══════════════════════════════════════════════════════════════════════════
-- Add template column to tokens
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tokens ADD COLUMN template TEXT NOT NULL DEFAULT 'custom';

-- ═══════════════════════════════════════════════════════════════════════════
-- Add ABL list address for on-chain allowlist/blocklist
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tokens ADD COLUMN abl_list_address TEXT;

CREATE INDEX idx_tokens_template ON tokens(template);
CREATE INDEX idx_tokens_abl_list ON tokens(abl_list_address);
