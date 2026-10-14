-- clare schema. Only the /api edge function touches these tables (as the postgres role);
-- RLS is on with no policies, so the public anon key can't read or write anything.

-- The one account clare manages: budget, policy, and the latest official meter reading.
create table clare_settings (
  id                      int primary key default 1 check (id = 1),
  account_name            text not null default 'My Claude',
  owner_name              text not null default '',
  plan                    text not null default 'max5' check (plan in ('pro', 'max5', 'max20')),
  -- Weekly budget in points (1 point = 1% of the official weekly limit).
  budget_pct              numeric(6, 2) not null default 100 check (budget_pct > 0 and budget_pct <= 100),
  -- Warn at this % of the budget.
  warn_pct                numeric(5, 2) not null default 80 check (warn_pct >= 10 and warn_pct < 100),
  -- Off = monitor only: nothing is blocked.
  enforce                 boolean not null default true,
  -- allowManagedHooksOnly on enrolled computers. Off by default: clare's block works without it, and
  -- turning it on silently disables your own Claude Code hooks and plugins.
  strict_hooks            boolean not null default false,
  capacity_manual         numeric check (capacity_manual is null or capacity_manual > 0),
  capacity_calibrated     numeric,
  calibrated_at           timestamptz,
  week_anchor             timestamptz not null,
  meter                   jsonb,
  meter_at                timestamptz,
  meter_device_id         uuid,
  unobserved_alerted      numeric not null default 0,   -- unobserved points already alerted this week
  unobserved_alert_week   timestamptz,                  -- resets_at of the week those points belong to
  last_unobserved_alert_at timestamptz,
  created_at              timestamptz not null
);

create table clare_enroll_codes (
  code_hash   text primary key,
  created_at  timestamptz not null,
  expires_at  timestamptz not null
);

create table clare_devices (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('cli', 'extension', 'web')),
  label               text not null default '',
  info                jsonb not null default '{}',
  machine_id          text,
  token_hash          text not null unique,
  bye_hash            text,
  enroll_code_hash    text,
  -- Optional weekly cap for this device, in points.
  budget_pct          numeric(6, 2) check (budget_pct is null or (budget_pct > 0 and budget_pct <= 100)),
  problem             text,
  last_seen_at        timestamptz,
  offline_alerted_at  timestamptz,
  alerts_seen_id      bigint not null default 0,   -- notification cursor (last alert id delivered)
  created_at          timestamptz not null,
  removed_at          timestamptz,
  removed_reason      text
);
create index clare_devices_active on clare_devices (kind) where removed_at is null;

create table clare_usage (
  id              bigint generated always as identity primary key,
  device_id       uuid references clare_devices (id) on delete set null,
  source          text not null check (source in ('cli', 'web')),
  key             text not null unique,
  model           text not null,
  input           bigint not null default 0,
  output          bigint not null default 0,
  cache_read      bigint not null default 0,
  cache_write     bigint not null default 0,
  cache_write_1h  bigint not null default 0,
  credits         numeric(14, 6) not null,
  estimated       boolean not null default false,
  at              timestamptz not null,
  created_at      timestamptz not null
);
create index clare_usage_at on clare_usage (at);
create index clare_usage_device_at on clare_usage (device_id, at);

create table clare_meter_readings (
  id              bigint generated always as identity primary key,
  device_id       uuid references clare_devices (id) on delete set null,
  at              timestamptz not null,
  week_pct        numeric(7, 3) not null,
  week_resets_at  timestamptz not null,
  five_pct        numeric(7, 3),
  five_resets_at  timestamptz,
  created_at      timestamptz not null
);
create index clare_meter_readings_at on clare_meter_readings (at);

create table clare_alerts (
  id           bigint generated always as identity primary key,
  device_id    uuid references clare_devices (id) on delete set null,
  kind         text not null check (kind in ('device_enrolled', 'device_removed', 'config_changed', 'device_offline', 'unobserved_usage')),
  message      text not null,
  created_at   timestamptz not null,
  resolved_at  timestamptz
);
create index clare_alerts_open on clare_alerts (created_at) where resolved_at is null;

create table clare_login_codes (
  code_hash   text primary key,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

alter table clare_settings       enable row level security;
alter table clare_enroll_codes   enable row level security;
alter table clare_devices        enable row level security;
alter table clare_usage          enable row level security;
alter table clare_meter_readings enable row level security;
alter table clare_alerts         enable row level security;
alter table clare_login_codes    enable row level security;
