-- What a credit of Claude Code vs claude.ai usage really costs, learned from meter rises
-- during which only one of them was active (see learnRates in core.ts).
alter table clare_settings add column source_rates jsonb;
