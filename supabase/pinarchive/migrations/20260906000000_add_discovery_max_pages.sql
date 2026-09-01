-- Migration: Add discovery_max_pages to pa_workspace_settings
-- Controls max pages scraped per account in a single discovery run (default: 50 pages = ~2,500 pins)

ALTER TABLE pa_workspace_settings
ADD COLUMN IF NOT EXISTS discovery_max_pages integer DEFAULT 50;
