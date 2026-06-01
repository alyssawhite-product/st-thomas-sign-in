-- St Thomas OPC -- clinic sub-stages migration.
-- Run this in the Supabase SQL editor after 0001_p0_scope.sql.
-- Safe to re-run.
--
-- Adds the three intermediate stages of the General Clinic flow:
--   waiting -> called -> at_records -> with_nurse -> with_doctor -> seen
-- Pharmacy retains its own intermediate stage ("preparing"), unchanged.

alter table public.queue_entries
  drop constraint if exists queue_entries_status_check;

alter table public.queue_entries
  add constraint queue_entries_status_check
  check (status in (
    'waiting',
    'called',
    'at_records',     -- General Clinic only: patient at the Records desk
    'with_nurse',     -- General Clinic only: with the Nurse
    'with_doctor',   -- General Clinic only: with the Doctor
    'preparing',     -- Pharmacy only
    'seen'
  ));

-- queue_audit: allow audit rows for the new sub-stage transitions.
alter table public.queue_audit
  drop constraint if exists queue_audit_action_check;

alter table public.queue_audit
  add constraint queue_audit_action_check
  check (action in (
    'sign_in',
    'call',
    'at_records',
    'with_nurse',
    'with_doctor',
    'preparing',
    'seen',
    'transfer',
    'priority_insert',
    'pharmacy_note',
    'reset_day'
  ));
