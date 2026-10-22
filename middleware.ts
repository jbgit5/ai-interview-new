import { NextRequest, NextResponse } from "next/server";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/dashboard")) {
    try {
      const res = await fetch(
        new URL("/api/auth/get-session", request.url).toString(),
        {
          headers: {
            cookie: request.headers.get("cookie") ?? "",
          },
          cache: "no-store",
        }
      );

      if (!res.ok) {
        return NextResponse.redirect(new URL("/sign-in", request.url));
      }

      const session = await res.json();
      if (!session?.user) {
        return NextResponse.redirect(new URL("/sign-in", request.url));
      }
    } catch {
      return NextResponse.redirect(new URL("/sign-in", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
