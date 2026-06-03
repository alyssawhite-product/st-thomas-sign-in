-- EE5: capture a free-text reason when visit_type is "other".
-- Optional column; existing rows are NULL. Length capped via app-side
-- validation (200 chars) but DB allows up to 500 in case staff types
-- a longer note.

ALTER TABLE queue_entries
  ADD COLUMN IF NOT EXISTS other_reason text;

COMMENT ON COLUMN queue_entries.other_reason IS
  'Patient-supplied "what brings you in" text when visit_type = other.';
