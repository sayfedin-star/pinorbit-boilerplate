-- Migration: 20260823000000_pinarchive_notes.sql
-- Description: Add notes and notes_updated_at columns to pa_pins table for editorial manual notes.

ALTER TABLE public.pa_pins ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.pa_pins ADD COLUMN IF NOT EXISTS notes_updated_at timestamptz;
