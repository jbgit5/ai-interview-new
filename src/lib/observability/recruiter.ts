import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

/** Resolve recruiter UUID for the signed-in user, or null. */
export async function getRecruiterIdForUser(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: headers() });
  if (!session?.user?.id) return null;
  const r = await pool.query(
    "SELECT id FROM recruiters WHERE better_auth_user_id = $1",
    [session.user.id]
  );
  return r.rows[0]?.id ?? null;
}
