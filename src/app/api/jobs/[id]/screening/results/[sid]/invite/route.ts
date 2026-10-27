import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { sendInviteEmail } from "@/lib/invites/sendInviteEmail";
import { UUID_RE, badRequest, notFound, requireRecruiterJob } from "@/lib/screening/access";
import { PlanQuestionSchema, createScreeningInvite } from "@/lib/screening/interviewPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InviteSchema = z.object({
  candidate_name: z.string().trim().min(1).max(160),
  candidate_email: z.string().trim().max(254),
  /** The candidate's own questions exactly as HR confirmed them on the interview-plan screen. */
  questions: z.array(PlanQuestionSchema),
  question_order: z.enum(["own_first", "common_first"]).optional().default("own_first"),
});

// POST → invite ONE candidate who is "Ready for interview". Explicit recruiter action after
// confirming the interview plan; never automatic. Rules live in createScreeningInvite().
export async function POST(request: NextRequest, { params }: { params: { id: string; sid: string } }) {
  const access = await requireRecruiterJob(request, params.id);
  if (!access.ok) return access.response;
  if (!UUID_RE.test(params.sid)) return notFound("Screening not found");

  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid invite");

  const result = await createScreeningInvite(
    pool,
    {
      job: access.job,
      recruiterId: access.recruiterId,
      screeningId: params.sid,
      candidateName: parsed.data.candidate_name,
      candidateEmail: parsed.data.candidate_email,
      questions: parsed.data.questions,
      questionOrder: parsed.data.question_order,
    },
    sendInviteEmail
  );
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json(result, { status: result.existing ? 200 : result.emailSent ? 201 : 207 });
}
