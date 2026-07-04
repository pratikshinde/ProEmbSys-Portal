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
      const isAdminRoute = nextUrl.pathname.startsWith("/admin")
      if (!isAdminRoute) return true
      const role = auth?.user?.role
      return role === "ADMIN" || role === "ENGINEER"
    },
  },
  providers: [],
}
