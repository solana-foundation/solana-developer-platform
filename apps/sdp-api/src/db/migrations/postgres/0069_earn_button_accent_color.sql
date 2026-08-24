-- Keep the CTA accent with the durable project configuration so the dashboard
-- preview and public engineering handoff render the same customer treatment.

ALTER TABLE earn_button_configurations
    ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#14F195';

ALTER TABLE earn_button_configurations
    DROP CONSTRAINT IF EXISTS earn_button_configurations_accent_color_hex;

ALTER TABLE earn_button_configurations
    ADD CONSTRAINT earn_button_configurations_accent_color_hex
    CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$');
