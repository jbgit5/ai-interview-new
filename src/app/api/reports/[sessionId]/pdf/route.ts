import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { format } from "date-fns";

const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_yes: "Strong Yes",
  yes: "Yes",
  no: "No",
  strong_no: "Strong No",
};

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: "Helvetica", fontSize: 10, color: "#111827" },
  header: { marginBottom: 24 },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  subtitle: { fontSize: 11, color: "#6B7280" },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 6, color: "#1D4ED8" },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  label: { color: "#6B7280" },
  value: { fontFamily: "Helvetica-Bold" },
  scoreBox: {
    flexDirection: "row",
    gap: 24,
    backgroundColor: "#F9FAFB",
    padding: 12,
    borderRadius: 4,
    marginBottom: 16,
  },
  scoreNumber: { fontSize: 28, fontFamily: "Helvetica-Bold" },
  badgeText: { fontSize: 11 },
  paragraph: { lineHeight: 1.5, marginBottom: 8 },
  bullet: { flexDirection: "row", marginBottom: 4 },
  bulletDot: { width: 12 },
  divider: { borderBottomWidth: 1, borderBottomColor: "#E5E7EB", marginVertical: 12 },
  turnRow: { flexDirection: "row", marginBottom: 8 },
  turnRole: { width: 80, fontFamily: "Helvetica-Bold", color: "#4B5563" },
  turnContent: { flex: 1, lineHeight: 1.4 },
  tableHeader: { flexDirection: "row", backgroundColor: "#F3F4F6", padding: 6, marginBottom: 2 },
  tableRow: { flexDirection: "row", padding: 6, borderBottomWidth: 1, borderBottomColor: "#F3F4F6" },
  col1: { width: "60%" },
  col2: { width: "20%", textAlign: "center" },
  col3: { width: "20%", textAlign: "center" },
});

// GET /api/reports/[sessionId]/pdf
export async function GET(
  _req: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { sessionId } = params;
  const client = await pool.connect();
  try {
    const sessionRow = await client.query(
      `SELECT
         s.id, s.candidate_name, s.candidate_email, s.status,
         s.started_at, s.completed_at, s.integrity_score,
         j.title AS job_title, r.company_name,
         a.overall_score, a.recommendation, a.ai_summary,
         a.competency_scores, a.strengths, a.concerns
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters r ON r.id = j.recruiter_id
       LEFT JOIN analysis_results a ON a.session_id = s.id
       WHERE s.id = $1 AND r.better_auth_user_id = $2`,
      [sessionId, session.user.id]
    );

    if (sessionRow.rows.length === 0) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const row = sessionRow.rows[0];

    const [turnsResult, scoresResult] = await Promise.all([
      client.query(
        `SELECT turn_index, role, content
           FROM transcript_turns
          WHERE session_id = $1
          ORDER BY turn_index, CASE WHEN role = 'interviewer' THEN 0 ELSE 1 END`,
        [sessionId]
      ),
      client.query(
        `SELECT q.text AS question_text,
                ROUND(AVG(qs.score)) AS score,
                (array_agg(qs.reasoning ORDER BY qs.turn_index DESC))[1] AS reasoning
           FROM question_scores qs
           LEFT JOIN questions q ON q.id = qs.question_id
          WHERE qs.session_id = $1
            AND qs.question_id IS NOT NULL
          GROUP BY q.id, q.text, q.order_index
          ORDER BY q.order_index`,
        [sessionId]
      ),
    ]);

    const candidateName = row.candidate_name ?? row.candidate_email;
    const completedAt = row.completed_at
      ? format(new Date(row.completed_at), "PPP")
      : "In progress";
    const score = row.overall_score ?? "—";
    const recommendation = RECOMMENDATION_LABELS[row.recommendation] ?? "—";
    const competencies: Record<string, number> = row.competency_scores ?? {};
    const strengths: string[] = row.strengths ?? [];
    const concerns: string[] = row.concerns ?? [];

    const doc = createElement(
      Document,
      {},
      createElement(
        Page,
        { size: "A4", style: styles.page },
        // Header
        createElement(
          View,
          { style: styles.header },
          createElement(Text, { style: styles.title }, `${row.job_title} — Interview Report`),
          createElement(Text, { style: styles.subtitle }, `${candidateName}  •  ${row.company_name ?? ""}  •  ${completedAt}`)
        ),
        // Scores summary
        createElement(
          View,
          { style: styles.scoreBox },
          createElement(
            View,
            {},
            createElement(Text, { style: { ...styles.label, fontSize: 9 } }, "OVERALL SCORE"),
            createElement(Text, { style: styles.scoreNumber }, String(score))
          ),
          createElement(
            View,
            {},
            createElement(Text, { style: { ...styles.label, fontSize: 9 } }, "RECOMMENDATION"),
            createElement(Text, { style: { ...styles.value, fontSize: 14 } }, recommendation)
          ),
          createElement(
            View,
            {},
            createElement(Text, { style: { ...styles.label, fontSize: 9 } }, "INTEGRITY SCORE"),
            createElement(Text, { style: { ...styles.value, fontSize: 14 } }, `${row.integrity_score ?? 100}`)
          )
        ),
        // Competency scores
        Object.keys(competencies).length > 0
          ? createElement(
              View,
              { style: styles.section },
              createElement(Text, { style: styles.sectionTitle }, "Competency Scores"),
              ...Object.entries(competencies).map(([comp, avg]) =>
                createElement(
                  View,
                  { style: styles.row, key: comp },
                  createElement(Text, { style: styles.label }, comp),
                  createElement(Text, { style: styles.value }, `${Math.round(Number(avg))} / 10`)
                )
              )
            )
          : createElement(View, {}),
        createElement(View, { style: styles.divider }),
        // AI Summary
        row.ai_summary
          ? createElement(
              View,
              { style: styles.section },
              createElement(Text, { style: styles.sectionTitle }, "AI Summary"),
              createElement(Text, { style: styles.paragraph }, row.ai_summary)
            )
          : createElement(View, {}),
        // Strengths
        strengths.length > 0
          ? createElement(
              View,
              { style: styles.section },
              createElement(Text, { style: styles.sectionTitle }, "Strengths"),
              ...strengths.map((s, i) =>
                createElement(
                  View,
                  { style: styles.bullet, key: i },
                  createElement(Text, { style: styles.bulletDot }, "•"),
                  createElement(Text, { style: { flex: 1 } }, s)
                )
              )
            )
          : createElement(View, {}),
        // Concerns
        concerns.length > 0
          ? createElement(
              View,
              { style: styles.section },
              createElement(Text, { style: styles.sectionTitle }, "Concerns"),
              ...concerns.map((c, i) =>
                createElement(
                  View,
                  { style: styles.bullet, key: i },
                  createElement(Text, { style: styles.bulletDot }, "•"),
                  createElement(Text, { style: { flex: 1 } }, c)
                )
              )
            )
          : createElement(View, {}),
        createElement(View, { style: styles.divider }),
        // Question scores table
        scoresResult.rows.length > 0
          ? createElement(
              View,
              { style: styles.section },
              createElement(Text, { style: styles.sectionTitle }, "Per-Question Scores"),
              createElement(
                View,
                { style: styles.tableHeader },
                createElement(Text, { style: styles.col1 }, "Question"),
                createElement(Text, { style: styles.col2 }, "Score"),
                createElement(Text, { style: styles.col3 }, "Reasoning")
              ),
              ...scoresResult.rows.map((qs, i) =>
                createElement(
                  View,
                  { style: styles.tableRow, key: i },
                  createElement(Text, { style: styles.col1 }, qs.question_text ?? "—"),
                  createElement(Text, { style: styles.col2 }, `${qs.score} / 10`),
                  createElement(Text, { style: styles.col3 }, qs.reasoning ?? "")
                )
              )
            )
          : createElement(View, {}),
        createElement(View, { style: styles.divider }),
        // Full transcript
        turnsResult.rows.length > 0
          ? createElement(
              View,
              { style: styles.section },
              createElement(Text, { style: styles.sectionTitle }, "Full Transcript"),
              ...turnsResult.rows.map((turn, i) =>
                createElement(
                  View,
                  { style: styles.turnRow, key: i },
                  createElement(
                    Text,
                    { style: styles.turnRole },
                    turn.role === "interviewer" ? "AI:" : "Candidate:"
                  ),
                  createElement(Text, { style: styles.turnContent }, turn.content)
                )
              )
            )
          : createElement(View, {})
      )
    );

    const buffer = await renderToBuffer(doc);
    const safeName = candidateName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    // Convert Node.js Buffer to Uint8Array so Web Response BodyInit accepts it
    const uint8 = new Uint8Array(buffer);

    return new Response(uint8, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report-${safeName}.pdf"`,
      },
    });
  } finally {
    client.release();
  }
}
