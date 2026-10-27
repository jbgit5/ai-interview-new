import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { sendInviteEmail } from "@/lib/invites/sendInviteEmail";
import { badRequest, requireRecruiterJob } from "@/lib/screening/access";
import { PlanQuestionSchema, createScreeningInvite } from "@/lib/screening/interviewPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BulkSchema = z.object({
  invites: z
    .array(
      z.object({
        screening_id: z.string().uuid(),
        candidate_name: z.string().trim().min(1).max(160),
        candidate_email: z.string().trim().max(254),
        questions: z.array(PlanQuestionSchema),
      })
    )
    .min(1)
    .max(50),
  /** Applies to every invite in this request. */
  question_order: z.enum(["own_first", "common_first"]).optional().default("own_first"),
});

// POST → invite several "Ready for interview" candidates after HR confirmed each plan.
// Processed one by one with the same rules as a single invite; one failure never blocks the rest.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  const parsed = BulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid request");

  const results = [];
  for (const inv of parsed.data.invites) {
    const r = await createScreeningInvite(
      pool,
      { job: access.job, recruiterId: access.recruiterId, screeningId: inv.screening_id, candidateName: inv.candidate_name, candidateEmail: inv.candidate_email, questions: inv.questions, questionOrder: parsed.data.question_order },
      sendInviteEmail
    );
    results.push({ screening_id: inv.screening_id, ...r });
  }
  return NextResponse.json({
    results,
    sent: results.filter((r) => r.ok && !r.existing && r.emailSent).length,
    failed: results.filter((r) => !r.ok).length,
  });
}
