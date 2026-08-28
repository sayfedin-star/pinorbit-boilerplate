-- Make interval columns nullable and deprecate
ALTER TABLE pa_workspace_settings ALTER COLUMN default_interval_days DROP NOT NULL;
ALTER TABLE pa_accounts ALTER COLUMN interval_days DROP NOT NULL;
COMMENT ON COLUMN pa_workspace_settings.default_interval_days IS 'DEPRECATED: Cron controls cadence now';
COMMENT ON COLUMN pa_accounts.interval_days IS 'DEPRECATED';
