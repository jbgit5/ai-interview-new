import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import OpenAI from "openai";
import { pool } from "@/lib/db";
import { insertTelemetryFireAndForget } from "@/lib/telemetry/server";
import type { TelemetryInsertRow } from "@/lib/telemetry/types";
import {
  buildInterviewSystemPrompt,
  buildOpeningPrompt,
  buildScoringPrompt,
  type Question,
} from "@/lib/prompts";
import {
  analyzeWeakAnswer,
  formatWeakAnswerForPrompt,
  isPlainIgnoranceNoProbePhrases,
} from "@/lib/weakAnswerSignals";

const MAX_TURNS = 10;

/** Maya thank-you / wrap-up prose while action is still "next" — confuses the client (re-opens mic). */
function looksLikeClosingGratitude(text: string): boolean {
  const t = text.toLowerCase();
  const phrases = [
    "thank you for your time",
    "thanks for your time",
    "thank you for joining",
    "appreciate you taking the time",
    "appreciate your time",
    "that concludes our",
    "this concludes our",
    "concludes the interview",
    "end of the interview",
    "end of our interview",
    "no further questions",
    "we've reached the end",
    "we have reached the end",
    "you've reached the end",
    "good luck with the rest",
    "we appreciate your interest",
    "appreciate your interest",
    "best of luck in your",
    "best of luck with",
    "this wraps up our",
    "wraps up our interview",
  ];
  return phrases.some((p) => t.includes(p));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTraceId(raw: unknown): string {
  if (typeof raw === "string" && UUID_RE.test(raw)) return raw;
  return randomUUID();
}

// POST /api/sessions/[token]/turn
// Body: { candidate_answer: string; turn_index: number; timestamp_ms?: number }
// Returns: { action, question, question_id, turn_index, is_closing }
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { token } = params;

  const body = await req.json();
  const candidateAnswer: string = body.candidate_answer ?? "";
  const turnIndex: number = body.turn_index ?? 0;
  const timestampMs: number = body.timestamp_ms ?? 0;
  const traceId = parseTraceId((body as { trace_id?: unknown }).trace_id);
  const bodyIgnoranceClaim =
    (body as { client_admits_no_knowledge?: unknown }).client_admits_no_knowledge === true;

  if (!candidateAnswer.trim()) {
    return Response.json({ error: "candidate_answer is required" }, { status: 400 });
  }

  const isOpeningTurn = candidateAnswer === "__opening__";
  /** Client flag or server phrase match — never on opening turn */
  const clientAdmitsNoKnowledge =
    !isOpeningTurn && (bodyIgnoranceClaim || isPlainIgnoranceNoProbePhrases(candidateAnswer));

  const client = await pool.connect();
  try {
    const tReq = Date.now();
    // Timing accumulators — assigned at each stage so the final metrics log
    // can compute per-stage durations without conditional checks.
    let tSession = tReq;
    let tDbLoad  = tReq;
    let tLlm     = tReq;

    const sessionResult = await client.query(
      `SELECT s.id, s.status, s.expires_at, s.resume_state,
              s.offtopic_redirect_issued,
              j.id AS job_id, j.title AS job_title, j.description AS job_description,
              j.allow_probes,
              COALESCE(
                (to_jsonb(r)->>'company_intro'),
                (to_jsonb(j)->>'company_intro')
              ) AS company_intro,
              r.company_name,
              s.candidate_name
         FROM interview_sessions s
         JOIN jobs j ON j.id = s.job_id
         JOIN recruiters r ON r.id = j.recruiter_id
        WHERE s.token = $1`,
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return Response.json({ error: "Invalid session token" }, { status: 401 });
    }

    const session = sessionResult.rows[0];

    if (new Date(session.expires_at) < new Date()) {
      return Response.json({ error: "Session expired" }, { status: 401 });
    }
    if (session.status === "completed") {
      return Response.json({ error: "Interview already completed" }, { status: 403 });
    }

    // Recruiter-configured per-job toggle. Default TRUE keeps legacy behavior for
    // jobs created before migration 012 ran.
    const allowProbes: boolean = session.allow_probes !== false;

    tSession = Date.now();

    // ── 2. Load questions, rubric, history, and probe counts IN PARALLEL ─────
    // These four reads are all independent of each other once we have session.id
    // and session.job_id from step 1 — running them in parallel cuts DB wait
    // from ~4 serial round-trips to the cost of the slowest single query.
    const [questionsResult, rubricResult, historyResult, probeResult] = await Promise.all([
      client.query(
        `SELECT id, text, category, difficulty, expected_hint
           FROM questions
          WHERE (job_id = $1 AND session_id IS NULL) OR session_id = $2
          ORDER BY CASE WHEN session_id IS NOT NULL THEN 0 ELSE 1 END, order_index`,
        [session.job_id, session.id]
      ),
      client.query(
        `SELECT competency FROM scoring_rubrics WHERE job_id = $1`,
        [session.job_id]
      ),
      client.query(
        `SELECT role, content, question_id
           FROM transcript_turns
          WHERE session_id = $1
          ORDER BY turn_index, CASE WHEN role = 'interviewer' THEN 0 ELSE 1 END`,
        [session.id]
      ),
      client.query(
        `SELECT question_id, probe_count FROM question_probe_counts WHERE session_id = $1`,
        [session.id]
      ),
    ]);

    const questions: Question[] = questionsResult.rows;
    const competencies: string[] = rubricResult.rows.map((r) => r.competency);
    tDbLoad = Date.now();

    const conversationHistory = historyResult.rows.map((row) => ({
      role: row.role === "interviewer" ? ("assistant" as const) : ("user" as const),
      content: row.content,
    }));

    const questionsAsked: string[] = historyResult.rows
      .filter((r) => r.question_id)
      .map((r) => r.question_id);

    // ── 3. Save candidate's answer to transcript_turns (skip for opening signal) ─
    if (!isOpeningTurn) {
      await client.query(
        `INSERT INTO transcript_turns (session_id, turn_index, role, content, timestamp_ms)
         VALUES ($1, $2, 'candidate', $3, $4)
         ON CONFLICT (session_id, turn_index, role) DO UPDATE SET content = EXCLUDED.content`,
        [session.id, turnIndex, candidateAnswer, timestampMs]
      );
    }

    // Add candidate answer to history for the GPT call
    const fullHistory = [
      ...conversationHistory,
      { role: "user" as const, content: candidateAnswer },
    ];

    // ── 4. Derive question context and probe counts from loaded data ────────
    const lastInterviewerRow = historyResult.rows
      .filter((r) => r.role === "interviewer" && r.question_id)
      .at(-1);

    const answerQuestion = lastInterviewerRow
      ? questions.find((q) => q.id === lastInterviewerRow.question_id)
      : null;

    const probeCounts: Record<string, number> = {};
    for (const row of probeResult.rows) {
      probeCounts[row.question_id] = row.probe_count;
    }

    // How many questions have been touched (at least one answer)
    const answeredQuestionIds = new Set(questionsAsked);
    // Competencies that have been covered by answered questions
    const coveredCompetencies = new Set(
      questions
        .filter((q) => answeredQuestionIds.has(q.id))
        .map((q) => q.category) // use category as proxy for competency coverage
    );
    const allCategories = ["technical", "behavioral", "situational", "culture"];
    const uncoveredCategories = allCategories.filter(
      (c) => !coveredCompetencies.has(c) && questions.some((q) => q.category === c)
    );

    // ── 6. Run GPT-4o brain + GPT-4o-mini scoring IN PARALLEL ─────────────
    const nextTurnIndex = turnIndex + 1;

    const scoringOpts = {
      questionText: answerQuestion?.text ?? "Interview question",
      expectedHint: answerQuestion?.expected_hint ?? "",
      competencies,
      candidateAnswer,
    };

    // ── 6. For opening turn: skip scoring, use dedicated plain-text prompt ──
    if (isOpeningTurn) {
      // gpt-4o-mini: much lower latency than gpt-4o for this short scripted opening — critical
      // for “first question within a few seconds” after Start Interview.
      const openingResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: buildOpeningPrompt({
              jobTitle: session.job_title,
              companyName: session.company_name ?? "the company",
              firstQuestion: questions[0]?.text ?? `Tell me about your background in ${session.job_title}.`,
              companyIntro: session.company_intro ?? undefined,
            }),
          },
        ],
        temperature: 0.65,
        max_tokens: 120,
      });

      const openingText = openingResponse.choices[0].message.content?.trim() ?? "";
      if (!openingText) {
        return Response.json({ error: "AI returned empty opening" }, { status: 500 });
      }

      // Save the AI greeting to transcript, linked to the first question so
      // that when the candidate answers Q1, lastInterviewerRow.question_id
      // is non-null and scoring has the correct question context.
      const firstQuestionId = questions[0]?.id ?? null;
      await client.query(
        `INSERT INTO transcript_turns
           (session_id, turn_index, role, content, question_id)
         VALUES ($1, $2, 'interviewer', $3, $4)
         ON CONFLICT (session_id, turn_index, role) DO UPDATE
           SET content = EXCLUDED.content`,
        [session.id, nextTurnIndex, openingText, firstQuestionId]
      );

      await client.query(
        `UPDATE interview_sessions SET resume_state = $1, updated_at = now() WHERE id = $2`,
        [JSON.stringify({ turn_index: nextTurnIndex, questions_asked: [], last_action: "next" }), session.id]
      );

      console.log(JSON.stringify({
        event: "turn_metrics",
        session_id: session.id,
        turn_index: 0,
        action: "opening",
        total_ms: Date.now() - tReq,
        llm_tokens: openingResponse.usage?.total_tokens ?? 0,
        is_opening: true,
      }));

      insertTelemetryFireAndForget(pool, [
        {
          session_id: session.id,
          event_name: "ai.brain.completed",
          event_version: 1,
          source: "server",
          trace_id: traceId,
          turn_index: nextTurnIndex,
          attrs: {
            opening: true,
            total_ms: Date.now() - tReq,
            llm_tokens: openingResponse.usage?.total_tokens ?? 0,
          },
        },
      ]);

      return Response.json({
        action: "next",
        question: openingText,
        question_id: questions[0]?.id ?? null,
        turn_index: nextTurnIndex,
        is_closing: false,
        trace_id: traceId,
      });
    }

    const weakAnswerAnalysis = analyzeWeakAnswer(candidateAnswer);
    const weakAnswerContext = formatWeakAnswerForPrompt(weakAnswerAnalysis);

    const promptOpts = {
      jobTitle: session.job_title,
      jobDescription: session.job_description ?? "",
      companyName: session.company_name ?? "the company",
      candidateName: session.candidate_name ?? undefined,
      questions,
      rubricCompetencies: competencies,
      conversationHistory: fullHistory,
      questionsAsked,
      currentTurn: nextTurnIndex,
      maxTurns: MAX_TURNS,
      probeCounts,
      uncoveredCategories,
      allowProbes,
      ...(weakAnswerContext ? { weakAnswerContext } : {}),
      ...(clientAdmitsNoKnowledge ? { forceMoveOnAfterIgnorance: true as const } : {}),
    };

    const [brainResponse, scoringResponse] = await Promise.all([
      openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildInterviewSystemPrompt(promptOpts) },
          ...fullHistory,
        ],
        temperature: 0.7,
        max_tokens: 400,
      }),
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildScoringPrompt(scoringOpts) }],
        temperature: 0.3,
        max_tokens: 300,
      }),
    ]);    tLlm = Date.now();
    // ── 7. Parse brain response ────────────────────────────────────────────
    let brainJSON: {
      action: "probe" | "next" | "close";
      question: string;
      question_id: string | null;
      notes: string;
    };

    try {
      brainJSON = JSON.parse(brainResponse.choices[0].message.content ?? "{}");
    } catch {
      return Response.json({ error: "Invalid JSON from AI brain" }, { status: 500 });
    }

    const { action: rawAction, question_id: rawQId } = brainJSON;
    let nextQuestion = brainJSON.question;

    // Safety-net: if GPT's closing text doesn't include the candidate's first name, prepend it.
    // e.g. "Thank you, Sarah! That concludes our interview…"
    const candidateFirstName = session.candidate_name?.split(" ")[0] ?? null;
    if (rawAction === "close" && candidateFirstName && nextQuestion) {
      const nameMentioned = nextQuestion.toLowerCase().includes(candidateFirstName.toLowerCase());
      if (!nameMentioned) {
        nextQuestion = `Thank you, ${candidateFirstName}! ${nextQuestion}`;
      }
    }
    // Validate GPT's returned question_id — must be an actual question ID from DB.
    // GPT sometimes fabricates placeholder values like "uuid-3" instead of copying the real UUID.
    let nextQId = questions.find((q) => q.id === rawQId)?.id ?? null;

    // ── Probe limit enforcement ────────────────────────────────────────────
    // If AI wants to probe but we've already probed this question MAX_PROBES times,
    // force it to move to the next question instead.
    const MAX_PROBES = 2;
    const currentQId = lastInterviewerRow?.question_id ?? null;
    const probesSoFar = currentQId ? (probeCounts[currentQId] ?? 0) : 0;

    let action: "probe" | "next" | "close" = rawAction ?? "next";

    if (action === "probe" && probesSoFar >= MAX_PROBES) {
      // Force next — find the first unasked question in an uncovered category, else any unasked
      action = "next";
      const preferredNext =
        questions.find((q) => !questionsAsked.includes(q.id) && uncoveredCategories.includes(q.category)) ??
        questions.find((q) => !questionsAsked.includes(q.id));
      if (preferredNext) {
        nextQId = preferredNext.id;
      }
    }

    // ── Probes-disabled enforcement ────────────────────────────────────────
    // When the recruiter has turned off follow-ups for this job, the AI must
    // never probe — even if the system prompt was ignored. Force "next" with
    // an unasked bank question, or "close" if every question has been asked.
    if (!allowProbes && action === "probe") {
      const preferredNext =
        questions.find((q) => !questionsAsked.includes(q.id) && uncoveredCategories.includes(q.category)) ??
        questions.find((q) => !questionsAsked.includes(q.id));
      if (preferredNext) {
        action = "next";
        nextQId = preferredNext.id;
        nextQuestion = preferredNext.text;
      } else {
        action = "close";
        const closingName = candidateFirstName ? `${candidateFirstName}` : "";
        nextQuestion = `Thank you${closingName ? `, ${closingName}` : ""}! That brings us to the end of our questions for today. We appreciate your time and will be in touch with next steps soon.`;
        nextQId = null;
      }
    }

    // Plain-ignorance: never probe; always prepend warm handoff for spoken TTS when moving on
    if (clientAdmitsNoKnowledge) {
      const unasked = questions.filter((q) => !questionsAsked.includes(q.id));
      if (unasked.length > 0 && action === "probe") {
        const preferredNext =
          questions.find((q) => !questionsAsked.includes(q.id) && uncoveredCategories.includes(q.category)) ??
          questions.find((q) => !questionsAsked.includes(q.id));
        if (preferredNext) {
          action = "next";
          nextQId = preferredNext.id;
          nextQuestion = preferredNext.text;
        } else {
          action = "next";
        }
      }
      // Model sometimes returns action "next" with an empty question — still speak a handoff + real question text.
      if (action === "next" && (!nextQuestion || !nextQuestion.trim()) && unasked.length > 0) {
        const preferredNext =
          questions.find((q) => !questionsAsked.includes(q.id) && uncoveredCategories.includes(q.category)) ??
          questions.find((q) => !questionsAsked.includes(q.id));
        if (preferredNext) {
          nextQId = preferredNext.id;
          nextQuestion = preferredNext.text;
        }
      }
      if (action === "next" && nextQuestion?.trim()) {
        const t = nextQuestion.trim();
        const alreadyWarm =
          /^(no worries|no problem)\b/i.test(t) ||
          /^that'?s okay\b/i.test(t) ||
          /^that is okay\b/i.test(t) ||
          /^don'?t worry\b/i.test(t) ||
          /\bno worries\b/i.test(t);
        if (!alreadyWarm) {
          nextQuestion = `No worries, let's move to the next question. ${nextQuestion}`;
        }
      }
    }

    // Update probe count if this was a probe turn
    if (action === "probe" && currentQId) {
      await client.query(
        `INSERT INTO question_probe_counts (session_id, question_id, probe_count)
         VALUES ($1, $2, 1)
         ON CONFLICT (session_id, question_id) DO UPDATE
           SET probe_count = question_probe_counts.probe_count + 1`,
        [session.id, currentQId]
      );
    }

    // ── Competency coverage guard ──────────────────────────────────────────
    // If AI wants to close but there are still uncovered categories with questions available,
    // force it to ask one more question from the uncovered area.
    if (action === "close" && uncoveredCategories.length > 0 && nextTurnIndex < MAX_TURNS - 1) {
      const missingCategoryQ = questions.find(
        (q) => !questionsAsked.includes(q.id) && uncoveredCategories.includes(q.category)
      );
      if (missingCategoryQ) {
        action = "next";
        nextQId = missingCategoryQ.id;
      }
    }

    // ── Closing vs next: model sometimes returns thank-you prose with action "next",
    // which leaves the client listening instead of completing. Align action with intent.
    const unaskedQuestions = questions.filter((q) => !questionsAsked.includes(q.id));
    if (nextQuestion && looksLikeClosingGratitude(nextQuestion)) {
      if (unaskedQuestions.length > 0 && nextTurnIndex < MAX_TURNS) {
        const pick =
          unaskedQuestions.find((q) => uncoveredCategories.includes(q.category)) ??
          unaskedQuestions[0];
        if (pick) {
          action = "next";
          nextQId = pick.id;
          nextQuestion = `Before we wrap up, one more question: ${pick.text}`;
        }
      } else {
        action = "close";
      }
    }

    // ── Hallucination guard ───────────────────────────────────────────────
    // CRITICAL: When action is "next", the AI MUST quote one of the bank
    // questions (validated via nextQId above). If nextQId is null (AI returned
    // a fake/empty ID — usually because it invented a brand-new question), or
    // every bank question has already been asked, override the turn so we only
    // ever speak text that came from the recruiter-curated bank, or a clean
    // close. Without this, GPT-4o occasionally fabricates fresh questions
    // after the bank is exhausted.
    if (action === "next") {
      const validBankId = nextQId != null && questions.some((q) => q.id === nextQId);
      if (!validBankId) {
        const preferredNext =
          questions.find(
            (q) => !questionsAsked.includes(q.id) && uncoveredCategories.includes(q.category)
          ) ?? questions.find((q) => !questionsAsked.includes(q.id));
        if (preferredNext) {
          nextQId = preferredNext.id;
          // Replace any fabricated text with the actual bank question text —
          // if clientAdmitsNoKnowledge already prepended a warm handoff,
          // re-apply it here so we don't lose the soft transition.
          const warmPrefix = clientAdmitsNoKnowledge ? "No worries, let's move to the next question. " : "";
          nextQuestion = `${warmPrefix}${preferredNext.text}`;
        } else {
          action = "close";
          const closingName = candidateFirstName ? `, ${candidateFirstName}` : "";
          nextQuestion = `Thank you${closingName}! That brings us to the end of our questions for today. We appreciate your time and will be in touch with next steps soon.`;
          nextQId = null;
        }
      }
    }

    // ── 8. Parse scoring + off-topic boundary check ────────────────────────
    // Parse scoring early so we can run the relevance check before committing
    // the brain's next question to the transcript.
    let scoringJSON: {
      scores?: Record<string, number>;
      reasoning?: string;
      overall?: number;
      is_relevant?: boolean;
      relevance_note?: string;
    } = {};

    try {
      scoringJSON = JSON.parse(scoringResponse.choices[0].message.content ?? "{}");
    } catch {
      console.error("[turn] Scoring parse failed — skipping relevance check");
    }

    // Gentle one-time off-topic redirect:
    // If GPT-4o-mini judged the answer as not relevant to the role AND we have not
    // already issued a redirect this session, Maya responds once with a professional
    // boundary statement and re-asks the current question.
    // After this the interview continues normally — no repeated blocking.
    // Skipped when probes are disabled for this job — recruiter has opted into
    // strict bank-only flow, so we move on without a redirect.
    if (allowProbes && scoringJSON.is_relevant === false && !session.offtopic_redirect_issued) {
      const currentQuestionText =
        answerQuestion?.text ??
        questions.find((q) => q.id === currentQId)?.text ??
        "the question I just asked";

      const redirectText =
        `I appreciate you sharing that, but as your AI interviewer today I'm here to ` +
        `focus only on questions relevant to this role — I'm not able to step outside ` +
        `the interview context. Let's get back on track: ${currentQuestionText}`;

      await client.query(
        `INSERT INTO transcript_turns
           (session_id, turn_index, role, content, question_id)
         VALUES ($1, $2, 'interviewer', $3, $4)
         ON CONFLICT (session_id, turn_index, role) DO UPDATE
           SET content = EXCLUDED.content, question_id = EXCLUDED.question_id`,
        [session.id, nextTurnIndex, redirectText, currentQId]
      );

      await client.query(
        `UPDATE interview_sessions
            SET offtopic_redirect_issued = true,
                resume_state = $1,
                updated_at   = now()
          WHERE id = $2`,
        [
          JSON.stringify({
            turn_index: nextTurnIndex,
            questions_asked: questionsAsked,
            last_action: "probe",
          }),
          session.id,
        ]
      );

      return Response.json({
        action: "probe",
        question: redirectText,
        question_id: currentQId ?? null,
        turn_index: nextTurnIndex,
        is_closing: false,
        offtopic_redirect: true,
        trace_id: traceId,
      });
    }

    // Save scoring to DB (non-blocking — failure must not break the interview turn)
    try {
      await client.query(
        `INSERT INTO question_scores
           (session_id, question_id, turn_index, score, reasoning, competencies)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          session.id,
          lastInterviewerRow?.question_id ?? null,
          turnIndex,
          Math.min(10, Math.max(1, scoringJSON.overall ?? 5)),
          scoringJSON.reasoning ?? "",
          JSON.stringify(scoringJSON.scores ?? {}),
        ]
      );
    } catch (err) {
      // Scoring failure should not block the interview — log and continue
      console.error("Scoring save failed:", err);
    }

    // ── 9. Save AI's next question / closing to transcript_turns ──────────
    if (action !== "close" || nextQuestion) {
      await client.query(
        `INSERT INTO transcript_turns
           (session_id, turn_index, role, content, question_id)
         VALUES ($1, $2, 'interviewer', $3, $4)
         ON CONFLICT (session_id, turn_index, role) DO UPDATE
           SET content = EXCLUDED.content, question_id = EXCLUDED.question_id`,
        [session.id, nextTurnIndex, nextQuestion, nextQId ?? null]
      );
    }

    // ── 10. Update resume_state on session ─────────────────────────────────
    const resumeState = {
      turn_index: nextTurnIndex,
      questions_asked: nextQId
        ? [...questionsAsked, nextQId]
        : questionsAsked,
      last_action: action,
    };

    await client.query(
      `UPDATE interview_sessions
          SET resume_state = $1, updated_at = now()
        WHERE id = $2`,
      [JSON.stringify(resumeState), session.id]
    );

    // ── Structured latency + cost log + DB persist ───────────────────────────────
    // Persisted to turn_metrics for p50/p95 queries on the report page.
    // Also emitted as JSON for log aggregators (Datadog, CloudWatch, Loki).
    const tNow = Date.now();
    const metricsRow = {
      session_id:               session.id,
      turn_index:               nextTurnIndex,
      action,
      db_session_ms:            tSession - tReq,
      db_parallel_ms:           tDbLoad  - tSession,
      llm_ms:                   tLlm     - tDbLoad,
      write_ms:                 tNow     - tLlm,
      total_ms:                 tNow     - tReq,
      brain_prompt_tokens:      brainResponse.usage?.prompt_tokens     ?? 0,
      brain_completion_tokens:  brainResponse.usage?.completion_tokens ?? 0,
      scoring_total_tokens:     scoringResponse.usage?.total_tokens    ?? 0,
      offtopic_redirect:        scoringJSON.is_relevant === false && !session.offtopic_redirect_issued,
    };
    console.log(JSON.stringify({ event: "turn_metrics", ...metricsRow }));
    // Non-blocking — metrics loss is acceptable; never block the interview response.
    client.query(
      `INSERT INTO turn_metrics
         (session_id, turn_index, action,
          db_session_ms, db_parallel_ms, llm_ms, write_ms, total_ms,
          brain_prompt_tokens, brain_completion_tokens, scoring_total_tokens,
          offtopic_redirect)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        metricsRow.session_id,
        metricsRow.turn_index,
        metricsRow.action,
        metricsRow.db_session_ms,
        metricsRow.db_parallel_ms,
        metricsRow.llm_ms,
        metricsRow.write_ms,
        metricsRow.total_ms,
        metricsRow.brain_prompt_tokens,
        metricsRow.brain_completion_tokens,
        metricsRow.scoring_total_tokens,
        metricsRow.offtopic_redirect,
      ]
    ).catch((err: unknown) => console.error("[turn] metrics insert failed:", err));

    const telemetryRows: TelemetryInsertRow[] = [
      {
        session_id: session.id,
        event_name: "ai.brain.completed",
        event_version: 1,
        source: "server",
        trace_id: traceId,
        turn_index: nextTurnIndex,
        attrs: {
          action,
          total_ms: metricsRow.total_ms,
          llm_ms: metricsRow.llm_ms,
          db_session_ms: metricsRow.db_session_ms,
          db_parallel_ms: metricsRow.db_parallel_ms,
        },
      },
    ];
    if (
      weakAnswerAnalysis.kinds.length > 0 ||
      weakAnswerAnalysis.weaknessScore >= 0.28
    ) {
      telemetryRows.push({
        session_id: session.id,
        event_name: "interview.weak_answer.signals",
        event_version: 1,
        source: "server",
        trace_id: traceId,
        turn_index: turnIndex,
        attrs: {
          kinds: weakAnswerAnalysis.kinds,
          weakness_score: weakAnswerAnalysis.weaknessScore,
        },
      });
    }
    insertTelemetryFireAndForget(pool, telemetryRows);

    return Response.json({
      action,
      question: nextQuestion,
      question_id: nextQId ?? null,
      turn_index: nextTurnIndex,
      is_closing: action === "close",
      trace_id: traceId,
    });
  } catch (err) {
    console.error("[turn] Unhandled error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
