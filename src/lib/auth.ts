import { betterAuth } from "better-auth";
import { pool } from "@/lib/db";

function trustedOrigins(): string[] {
  const candidates = [
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
  return Array.from(
    new Set(candidates.filter((u): u is string => Boolean(u?.trim())))
  );
}

const origins = trustedOrigins();
const appUrl =
  process.env.BETTER_AUTH_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3000";

export const auth = betterAuth({
  baseURL: appUrl,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: origins,
  advanced: {
    trustedProxyHeaders: true,
    useSecureCookies: appUrl.startsWith("https://"),
  },
  database: pool,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "recruiter",
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // After better-auth creates the user, insert a row in our recruiters table
          try {
            await pool.query(
              `INSERT INTO recruiters (better_auth_user_id, email, name)
               VALUES ($1, $2, $3)
               ON CONFLICT (better_auth_user_id) DO NOTHING`,
              [user.id, user.email, user.name ?? null]
            );
          } catch (error) {
            console.error("Failed to create recruiter row:", error);
            // Don't throw - let the user be created even if recruiter row fails
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
