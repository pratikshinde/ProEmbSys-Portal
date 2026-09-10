import type { NextAuthConfig } from "next-auth"

// Edge-safe subset of the auth config — used directly by middleware.ts, which
// runs on the Edge runtime and cannot load the Prisma adapter or bcryptjs.
// The full config (adapter + Credentials provider) lives in auth.ts and
// spreads this in, so the `authorized` callback below runs everywhere.
export const authConfig: NextAuthConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const { pathname } = nextUrl
      const role = auth?.user?.role

      if (pathname.startsWith("/admin")) {
        return role === "ADMIN" || role === "ENGINEER"
      }
      // Production tracker — staff plus the OPERATOR role, never customers.
      // Kept in sync with canAccessProduction() in src/lib/roles.ts (not
      // imported here — this file stays Edge-safe with zero deps).
      if (pathname.startsWith("/production")) {
        if (role === "ADMIN" || role === "ENGINEER" || role === "OPERATOR") return true
        // A visitor here belongs in the operator app's own sign-in, not the
        // main site's /login; a logged-in non-operator goes home.
        return Response.redirect(new URL(auth?.user ? "/" : "/operator/login", nextUrl))
      }
      return true
    },
  },
  providers: [],
}
