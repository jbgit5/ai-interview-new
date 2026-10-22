import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await pool.query(
      `SELECT (to_jsonb(recruiters)->>'company_intro') AS company_intro
         FROM recruiters
        WHERE better_auth_user_id = $1`,
      [session.user.id]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ error: "Recruiter not found" }, { status: 404 });
    }

    return NextResponse.json({ company_intro: result.rows[0].company_intro ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const companyIntroRaw: unknown = body?.company_intro;
  const companyIntro =
    typeof companyIntroRaw === "string" ? companyIntroRaw.trim().slice(0, 300) : "";

  try {
    const result = await pool.query(
      `UPDATE recruiters
          SET company_intro = $1,
              updated_at    = now()
        WHERE better_auth_user_id = $2
        RETURNING company_intro`,
      [companyIntro || null, session.user.id]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ error: "Recruiter not found" }, { status: 404 });
    }

    return NextResponse.json({ company_intro: result.rows[0].company_intro ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

