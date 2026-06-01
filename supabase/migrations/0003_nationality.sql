-- St Thomas OPC -- nationality migration.
-- Run this in the Supabase SQL editor after 0001_p0_scope.sql.
-- Safe to re-run.
--
-- Adds support for nationality-aware registration introduced at the
-- May 27, 2026 stakeholder meeting:
--
--   * National patients identify with a Barbados National ID number.
--   * Non-National patients identify with either a National ID or a
--     Passport from their country of origin.

alter table public.queue_entries
  add column if not exists nationality        text,
  add column if not exists country_of_origin  text;

alter table public.queue_entries
  drop constraint if exists queue_entries_nationality_check;

alter table public.queue_entries
  add constraint queue_entries_nationality_check
  check (
    nationality is null
    or nationality in ('national', 'non_national')
  );

-- Country of origin is only meaningful for non-nationals. Enforce that
-- pairing at the schema level so bad data can't leak in.
alter table public.queue_entries
  drop constraint if exists queue_entries_country_pairing_check;

alter table public.queue_entries
  add constraint queue_entries_country_pairing_check
  check (
    nationality is null
    or (nationality = 'national' and country_of_origin is null)
    or (nationality = 'non_national')
  );
