-- ==============================================================================
-- Migration: 20260906000000_drop_stale_increment_overload.sql
-- Project: Project 1 (Scheduling: eygdoetdwqllvsxpvoex)
-- Description: Drops stale 2-argument increment_webhook_execution overload to
--              prevent legacy overload revival and privilege leakage.
-- ==============================================================================

DROP FUNCTION IF EXISTS public.increment_webhook_execution(UUID, INTEGER);
