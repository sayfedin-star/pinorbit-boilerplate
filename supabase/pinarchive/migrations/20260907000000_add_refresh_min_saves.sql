-- Migration: Add refresh_min_saves to pa_workspace_settings
-- Allows workspace admins to gate refresh routines by minimum pin saves.
-- Default 0 means refresh all pins regardless of saves.

ALTER TABLE pa_workspace_settings 
ADD COLUMN IF NOT EXISTS refresh_min_saves integer DEFAULT 0;

