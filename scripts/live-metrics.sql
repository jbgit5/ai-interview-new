-- GPT-Live vs standard engine — how is the interview actually improving?
--
-- Run (local):
--   Get-Content scripts/live-metrics.sql -Raw | docker exec -i ai-interview-local-postgres psql -U postgres -d ai_interview
-- Run (prod):
--   psql "$DATABASE_URL" -f scripts/live-metrics.sql
--
-- A session counts as "live" if it emitted live.session.started; otherwise "legacy" (Deepgram + TTS).
-- All durations are seconds. Re-run after each batch of test interviews and compare.

\pset footer off
\echo
\echo '=== 1. THE HEADLINE: candidate stops talking -> next question text ready (seconds) ==='
\echo '    live   = last transcript text -> question handed to Maya (live.turn.completed)'
\echo '    legacy = last STT text -> question text returned (llm.turn.completed; includes the 7.2s silence-commit window)'
WITH waits AS (
  SELECT 'live' AS engine, (attrs->>'last_candidate_delta_to_commentary_ms')::numeric / 1000 AS secs
    FROM session_telemetry_events
   WHERE event_name = 'live.turn.completed' AND attrs->>'last_candidate_delta_to_commentary_ms' IS NOT NULL
  UNION ALL
  SELECT 'legacy', (attrs->>'last_transcript_to_question_ms')::numeric / 1000
    FROM session_telemetry_events
   WHERE event_name = 'llm.turn.completed' AND attrs->>'last_transcript_to_question_ms' IS NOT NULL
)
SELECT engine,
       count(*)                                              AS turns,
       round(avg(secs), 1)                                   AS avg_s,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::numeric, 1) AS median_s,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY secs)::numeric, 1) AS p90_s,
       round(max(secs), 1)                                   AS worst_s
  FROM waits GROUP BY engine ORDER BY engine;

\echo
\echo '=== 2. LIVE ONLY: silence before the candidate hears ANY reply (acknowledgement or question) ==='
\echo '    (the "Mm-hm" is now voiced by the model itself, so the old ack=true/false split is historical)'
SELECT attrs->>'ack' AS ack,
       count(*)      AS turns,
       round(avg((attrs->>'since_last_candidate_delta_ms')::numeric) / 1000, 1) AS avg_s,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (attrs->>'since_last_candidate_delta_ms')::numeric)::numeric / 1000, 1) AS median_s,
       round(max((attrs->>'since_last_candidate_delta_ms')::numeric) / 1000, 1) AS worst_s
  FROM session_telemetry_events
 WHERE event_name = 'live.maya.first_audio' AND attrs->>'since_last_candidate_delta_ms' IS NOT NULL
 GROUP BY 1 ORDER BY 1;

\echo
\echo '=== 3. SERVER: where does /turn spend its time? (both engines) ==='
\echo '    scorer_extra_wait > 0 means scoring directly delayed the candidate; fallback = brain timed out/failed'
SELECT count(*)                                                    AS turns,
       round(avg((attrs->>'brain_ms')::numeric) / 1000, 2)         AS brain_avg_s,
       round(max((attrs->>'brain_ms')::numeric) / 1000, 2)         AS brain_worst_s,
       round(avg((attrs->>'scorer_ms')::numeric) / 1000, 2)        AS scorer_avg_s,
       round(avg((attrs->>'scorer_extra_wait_ms')::numeric) / 1000, 2) AS scorer_extra_wait_avg_s,
       count(*) FILTER (WHERE (attrs->>'brain_fallback')::boolean) AS brain_fallbacks,
       count(*) FILTER (WHERE (attrs->>'scorer_failed')::boolean)  AS scorer_failures
  FROM session_telemetry_events
 WHERE event_name = 'ai.brain.completed' AND attrs ? 'brain_ms';

\echo
\echo '=== 4. INTERVIEW OUTCOMES by engine (completed sessions only) ==='
WITH eng AS (
  SELECT session_id,
         CASE WHEN bool_or(event_name = 'live.session.started') THEN 'live' ELSE 'legacy' END AS engine
    FROM session_telemetry_events GROUP BY session_id
)
SELECT e.engine,
       count(*)                                                                             AS sessions,
       round(avg(extract(epoch FROM (s.completed_at - s.started_at)) / 60)::numeric, 1)     AS avg_minutes,
       round(avg((SELECT count(*) FROM transcript_turns t WHERE t.session_id = s.id AND t.role = 'candidate')), 1) AS avg_answers,
       round(100.0 * avg((s.exit_type = 'early_exit')::int), 0)                             AS early_exit_pct
  FROM eng e JOIN interview_sessions s ON s.id = e.session_id
 WHERE s.status = 'completed'
 GROUP BY e.engine ORDER BY e.engine;

\echo
\echo '=== 5. LIVE SETUP: ms since connect began (gaps show the slow step) ==='
SELECT to_char(occurred_at, 'MM-DD HH24:MI') AS at,
       attrs->>'mic_at_ms'    AS mic,
       attrs->>'offer_at_ms'  AS offer,
       attrs->>'ice_at_ms'    AS ice_done,
       attrs->>'create_at_ms' AS created,
       attrs->>'ready_at_ms'  AS ready,
       attrs->>'setup_ms'     AS total
  FROM session_telemetry_events
 WHERE event_name = 'live.session.started'
 ORDER BY occurred_at DESC LIMIT 10;

\echo
\echo '=== 5b. REALISTIC AVATAR (Simli): did it start, how fast, and how often does it fail? ==='
SELECT count(*) FILTER (WHERE event_name = 'avatar.simli.started')  AS started,
       count(*) FILTER (WHERE event_name = 'avatar.simli.failed')   AS failed,
       round(avg((attrs->>'setup_ms')::numeric) FILTER (WHERE event_name = 'avatar.simli.started') / 1000, 1) AS avg_start_s,
       round(max((attrs->>'setup_ms')::numeric) FILTER (WHERE event_name = 'avatar.simli.started') / 1000, 1) AS worst_start_s
  FROM session_telemetry_events
 WHERE event_name IN ('avatar.simli.started', 'avatar.simli.failed');
SELECT attrs->>'reason' AS failure_reason, count(*) AS n
  FROM session_telemetry_events WHERE event_name = 'avatar.simli.failed'
 GROUP BY 1 ORDER BY 2 DESC;

\echo
\echo '=== 6. LIVE SPEND (ledger; $0.05/min voice layer, billed per second) ==='
SELECT count(*)                                              AS sessions,
       coalesce(sum(usage_seconds), 0)                       AS billed_seconds,
       round(coalesce(sum(usage_seconds), 0) / 60.0 * 0.05, 2) AS approx_usd,
       count(*) FILTER (WHERE closed_at IS NULL)             AS still_open
  FROM live_voice_sessions;

\echo
\echo '=== 7. AVATAR SPEND (ledger; Simli ~$0.05/min per third-party sources — verify on their pricing page) ==='
SELECT count(*)                                              AS sessions,
       coalesce(sum(usage_seconds), 0)                       AS billed_seconds,
       round(coalesce(sum(usage_seconds), 0) / 60.0 * 0.05, 2) AS approx_usd,
       count(*) FILTER (WHERE closed_at IS NULL)             AS still_open
  FROM avatar_sessions;

\echo
\echo '=== 8. TURN-TAKING & DELIVERY (GPT-Live): is Maya waiting too long, and does she say what we told her? ==='
SELECT count(*) FILTER (WHERE event_name = 'live.turn.forced')                                   AS turns_ended_by_our_timer,
       count(*) FILTER (WHERE event_name = 'live.turn.force_regret')                             AS candidate_cut_off,
       count(*) FILTER (WHERE event_name = 'live.turn.delivery')                                 AS questions_checked,
       count(*) FILTER (WHERE event_name = 'live.turn.delivery' AND attrs->>'delivered' = 'false'
                          AND coalesce(attrs->>'candidate_spoke','false') <> 'true')             AS not_asked_as_intended,
       count(*) FILTER (WHERE event_name = 'live.closing.audio')                                 AS goodbyes,
       count(*) FILTER (WHERE event_name = 'live.closing.audio' AND attrs->>'delivered' = 'false') AS goodbyes_not_said,
       count(*) FILTER (WHERE event_name = 'live.question.nudged')                               AS nudges,
       count(*) FILTER (WHERE event_name = 'live.delegation.stray')                              AS duplicate_requests_ignored
  FROM session_telemetry_events;
\echo '    forced-turn silence (seconds) — how long candidates sat silent before WE moved on:'
SELECT count(*) AS n,
       round(avg((attrs->>'silence_ms')::numeric) / 1000, 1) AS avg_s,
       round(max((attrs->>'silence_ms')::numeric) / 1000, 1) AS max_s
  FROM session_telemetry_events WHERE event_name = 'live.turn.forced';
\echo '    avatar stops (Simli ended the session) — the evidence for WHY:'
SELECT to_char(occurred_at, 'MM-DD HH24:MI') AS at,
       round((attrs->>'since_start_ms')::numeric / 1000, 1) AS ran_s,
       attrs->>'kind' AS kind, attrs->>'ws_close_code' AS close_code, attrs->>'ws_close_reason' AS close_reason,
       round((attrs->>'ms_since_maya_audible')::numeric / 1000, 1) AS maya_silent_for_s,
       left(attrs->>'last_messages', 90) AS last_messages
  FROM session_telemetry_events WHERE event_name = 'avatar.simli.stopped' ORDER BY occurred_at DESC LIMIT 8;
