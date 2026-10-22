"use client";

import { createAuthClient } from "better-auth/react";

/** Same origin as the page — avoids INVALID_ORIGIN when env and browser URL differ. */
function authBaseURL(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export const authClient = createAuthClient({
  baseURL: authBaseURL(),
});

export const { signIn, signOut, signUp, useSession } = authClient;
