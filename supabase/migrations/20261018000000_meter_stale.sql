-- Claude's usage meter going unread for a day raises an alert; see "Alerts" in docs/ARCHITECTURE.md.
alter table clare_alerts drop constraint clare_alerts_kind_check;
alter table clare_alerts add constraint clare_alerts_kind_check
  check (kind in ('device_enrolled', 'device_removed', 'config_changed', 'device_offline', 'unobserved_usage', 'meter_stale'));
-- When it was last raised, so each stretch without a reading raises it once.
alter table clare_settings add column meter_stale_alerted_at timestamptz;
