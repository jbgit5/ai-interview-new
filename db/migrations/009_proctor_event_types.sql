-- Migration 009: Expand proctoring_events event_type constraint
--
-- Original constraint (001_core_tables.sql) only included 6 types.
-- The useProctor hook fires these additional types that were missing:
--   phone_detected, right_click, devtools_open, fullscreen_exit, window_focus
--
-- We drop the old check and add the full set.

ALTER TABLE proctoring_events
  DROP CONSTRAINT IF EXISTS proctoring_events_event_type_check;

ALTER TABLE proctoring_events
  ADD CONSTRAINT proctoring_events_event_type_check
  CHECK (event_type IN (
    'tab_switch',
    'window_blur',
    'window_focus',
    'multi_face',
    'no_face',
    'gaze_away',
    'paste_detected',
    'right_click',
    'devtools_open',
    'fullscreen_exit',
    'phone_detected'
  ));
