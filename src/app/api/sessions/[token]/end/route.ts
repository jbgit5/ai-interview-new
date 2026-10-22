import { NextRequest } from "next/server";
import OpenAI from "openai";
import { pool } from "@/lib/db";
import { buildSummaryPrompt } from "@/lib/prompts";
import { computeAndUpsertSessionSummary } from "@/lib/telemetry/summary";

// POST /api/sessions/[token]/end
// Body: { integrity_score?: number; video_chunk_count?: number }
// Runs full analysis pipeline: scores → summary → insert analysis_results
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { token } = params;
  const body = await req.json().catch(() => ({}));
  const integrityScore: number = body.integrity_score ?? 100;
  const earlyExit: boolean = body.early_exit === true;

  const client = await pool.connect();
  try {
    // ── 1. Validate + load session ─────────────────────────────────────────
    const sessionResult = await client.query(
      `SELECT s.id, s.status, s.expires_at,
              j.id AS job_id, j.title AS job_title, j.description AS job_description,
              r.company_name, r.email AS recruiter_email
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
    if (session.status === "completed") {
      // If already completed (e.g. duplicate call), just return success silently
      return Response.json({ ok: true, already_completed: true });
    }

    // ── 2. Mark session completed ──────────────────────────────────────────
    await client.query(
      `UPDATE interview_sessions
          SET status = 'completed',
              completed_at = now(),
              integrity_score = $1,
              exit_type = $2,
              updated_at = now()
        WHERE id = $3`,
      [integrityScore, earlyExit ? "early_exit" : "normal", session.id]
    );

    // ── 3. Load transcript turns ───────────────────────────────────────────
    const turnsResult = await client.query(
      `SELECT role, content, turn_index
         FROM transcript_turns
        WHERE session_id = $1
        ORDER BY turn_index, CASE WHEN role = 'interviewer' THEN 0 ELSE 1 END`,
      [session.id]
    );

    // ── 4. Load all per-answer scores ─────────────────────────────────────
    const scoresResult = await client.query(
      `SELECT score, reasoning, competencies
         FROM question_scores
        WHERE session_id = $1`,
      [session.id]
    );

    // ── 5. Load scoring rubric ─────────────────────────────────────────────
    const rubricResult = await client.query(
      `SELECT competency, weight
         FROM scoring_rubrics
        WHERE job_id = $1`,
      [session.job_id]
    );

    const rubric: Array<{ competency: string; weight: number }> =
      rubricResult.rows;

    // ── 6. Aggregate competency scores from question_scores ────────────────
    // Each question_scores.competencies is a JSONB object: { "Technical Depth": 7, ... }
    const competencyAccumulator: Record<string, number[]> = {};

    for (const row of scoresResult.rows) {
      const scoreMap: Record<string, number> =
        typeof row.competencies === "object" && row.competencies !== null
          ? row.competencies
          : {};
      for (const [competency, score] of Object.entries(scoreMap)) {
        if (!competencyAccumulator[competency]) {
          competencyAccumulator[competency] = [];
        }
        competencyAccumulator[competency].push(Number(score));
      }
    }

    // Average per competency
    const competencyAvgs: Record<string, number> = {};
    for (const [comp, scores] of Object.entries(competencyAccumulator)) {
      competencyAvgs[comp] =
        scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    // ── 7. Apply rubric weights → weighted overall score ──────────────────
    // Formula: 60% weighted competency score + 20% avg overall + 20% integrity
    const totalWeight = rubric.reduce((sum, r) => sum + r.weight, 0) || 100;

    let weightedCompetencyScore = 0;
    for (const { competency, weight } of rubric) {
      const avg = competencyAvgs[competency] ?? 5; // default to mid if not scored
      weightedCompetencyScore += (avg / 10) * 100 * (weight / totalWeight);
    }

    const allOverallScores = scoresResult.rows.map((r) => Number(r.score));
    const avgOverall =
      allOverallScores.length > 0
        ? allOverallScores.reduce((a, b) => a + b, 0) / allOverallScores.length
        : 5;
    const avgOverallPct = (avgOverall / 10) * 100;

    const finalScore = Math.round(
      weightedCompetencyScore * 0.6 +
        avgOverallPct * 0.2 +
        integrityScore * 0.2
    );

    // ── 8. Determine recommendation ───────────────────────────────────────
    const recommendation =
      finalScore >= 80
        ? "strong_yes"
        : finalScore >= 65
        ? "yes"
        : finalScore >= 50
        ? "no"
        : "strong_no";

    // ── 9. Build transcript text for GPT-4o summary ───────────────────────
    const sortedTurns = [...turnsResult.rows].sort(
      (a, b) => a.turn_index - b.turn_index || a.role.localeCompare(b.role)
    );

    const transcriptText = sortedTurns
      .map((t) => {
        const speaker = t.role === "interviewer" ? "AI Interviewer" : "Candidate";
        return `${speaker}: ${t.content}`;
      })
      .join("\n\n");

    // ── 10. GPT-4o summary ────────────────────────────────────────────────
    let summaryData = {
      summary: "Interview completed. Summary not available.",
      strengths: [] as string[],
      concerns: [] as string[],
      recommendation_text: "No recommendation",
    };

    try {
      const summaryResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: buildSummaryPrompt({
              jobTitle: session.job_title,
              companyName: session.company_name ?? "the company",
              transcript: transcriptText,
            }),
          },
        ],
        temperature: 0.5,
        max_tokens: 800,
      });

      summaryData = JSON.parse(
        summaryResponse.choices[0].message.content ?? "{}"
      );
    } catch (err) {
      console.error("Summary generation failed:", err);
    }

    // ── 11. Aggregate turn_metrics for cost rollup ────────────────────────
    // GPT pricing (update if OpenAI changes rates):
    //   GPT-4o input:   $2.50 / 1M tokens   = $0.0000025 / token
    //   GPT-4o output:  $10.00 / 1M tokens  = $0.000010  / token
    //   GPT-4o-mini:    ~$0.15 / 1M tokens  = $0.00000015 / token (scoring, blended)
    //   TTS-1:          $15.00 / 1M chars   = $0.000015  / char
    const metricsResult = await client.query(
      `SELECT
         COALESCE(SUM(brain_prompt_tokens),     0) AS total_brain_prompt,
         COALESCE(SUM(brain_completion_tokens), 0) AS total_brain_completion,
         COALESCE(SUM(scoring_total_tokens),    0) AS total_scoring
       FROM turn_metrics
      WHERE session_id = $1`,
      [session.id]
    );

    const mx = metricsResult.rows[0] ?? {};
    const totalBrainPrompt     = Number(mx.total_brain_prompt)      || 0;
    const totalBrainCompletion = Number(mx.total_brain_completion)   || 0;
    const totalScoring         = Number(mx.total_scoring)            || 0;

    // TTS char count: sum all interviewer turns (Maya's spoken text)
    const ttsResult = await client.query(
      `SELECT COALESCE(SUM(LENGTH(content)), 0) AS total_chars
         FROM transcript_turns
        WHERE session_id = $1 AND role = 'interviewer'`,
      [session.id]
    );
    const totalTtsChars = Number(ttsResult.rows[0]?.total_chars) || 0;

    const estimatedCostUsd =
      totalBrainPrompt     * 0.0000025  +   // GPT-4o input
      totalBrainCompletion * 0.000010   +   // GPT-4o output
      totalScoring         * 0.00000015 +   // GPT-4o-mini
      totalTtsChars        * 0.000015;      // TTS-1

    // ── 12. Insert analysis_results ───────────────────────────────────────
    await client.query(
      `INSERT INTO analysis_results
         (session_id, overall_score, recommendation, ai_summary,
          competency_scores, strengths, concerns,
          total_brain_prompt_tokens, total_brain_completion_tokens,
          total_scoring_tokens, total_tts_chars, estimated_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (session_id) DO UPDATE
         SET overall_score                  = EXCLUDED.overall_score,
             recommendation                 = EXCLUDED.recommendation,
             ai_summary                     = EXCLUDED.ai_summary,
             competency_scores              = EXCLUDED.competency_scores,
             strengths                      = EXCLUDED.strengths,
             concerns                       = EXCLUDED.concerns,
             total_brain_prompt_tokens      = EXCLUDED.total_brain_prompt_tokens,
             total_brain_completion_tokens  = EXCLUDED.total_brain_completion_tokens,
             total_scoring_tokens           = EXCLUDED.total_scoring_tokens,
             total_tts_chars                = EXCLUDED.total_tts_chars,
             estimated_cost_usd             = EXCLUDED.estimated_cost_usd`,
      [
        session.id,
        finalScore,
        recommendation,
        summaryData.summary,
        JSON.stringify(competencyAvgs),
        summaryData.strengths,
        summaryData.concerns,
        totalBrainPrompt,
        totalBrainCompletion,
        totalScoring,
        totalTtsChars,
        estimatedCostUsd.toFixed(4),
      ]
    );

    await computeAndUpsertSessionSummary(client, session.id).catch((err: unknown) => {
      console.error("[end] telemetry summary failed:", err);
    });

    return Response.json({
      success: true,
      overall_score: finalScore,
      recommendation,
      estimated_cost_usd: estimatedCostUsd.toFixed(4),
    });
  } finally {
    client.release();
  }
}
