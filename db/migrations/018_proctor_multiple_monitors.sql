-- Migration 018: allow the 'multiple_monitors' proctoring event (extended desktop / second monitor).
-- Same pattern as 009: drop the check and re-add it with the full set of event types.

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
    'phone_detected',
    'multiple_monitors'
  ));
