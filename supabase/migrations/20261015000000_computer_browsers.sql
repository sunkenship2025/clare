-- A browser can belong to a computer: added through `clare` on that computer, or linked on the
-- dashboard. The computer's cap then covers Claude Code and its browsers together, and the
-- dashboard shows them as one computer.

alter table clare_devices add column parent_id uuid references clare_devices (id) on delete set null;
create index clare_devices_parent on clare_devices (parent_id) where parent_id is not null;

-- Browser codes minted by a computer (`clare browser`, the install's browser guide) carry it.
alter table clare_enroll_codes add column parent_id uuid references clare_devices (id) on delete set null;
