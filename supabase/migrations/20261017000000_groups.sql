-- Groups of computers: each group has a share of the weekly limit, split between its computers.
-- A computer stops at the first of its own cap, its group's share, and the account budget.
-- Only a computer (or a browser on its own) is in a group; browsers on a computer follow it.

create table clare_groups (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  -- The group's share of the weekly limit, in points.
  budget_pct  numeric(6, 2) not null check (budget_pct > 0 and budget_pct <= 100),
  created_at  timestamptz not null
);
alter table clare_groups enable row level security;

-- Deleting a group takes its computers out of it.
alter table clare_devices add column group_id uuid references clare_groups (id) on delete set null;
-- "Add a device" links can put the new computer straight into a group.
alter table clare_enroll_codes add column group_id uuid references clare_groups (id) on delete set null;
