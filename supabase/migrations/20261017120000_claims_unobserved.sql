-- A device can take this week's usage clare couldn't see from before it was added (e.g. someone used
-- Claude on a computer before clare was on it). Unseen parts of meter rises go to the first such
-- device added after the rise's interval began; see "Attribution" in docs/ARCHITECTURE.md.
alter table clare_devices add column claim_until timestamptz;
-- "Add a device" links can switch it on for the new device.
alter table clare_enroll_codes add column claim_unobserved boolean not null default false;

-- Rates learned before rises were capped could include usage clare couldn't see; learn them again.
update clare_settings set capacity_calibrated = null, calibrated_at = null, source_rates = null;
