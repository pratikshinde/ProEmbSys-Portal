import type { Role } from "@prisma/client"
import type { DefaultSession } from "next-auth"

// Auth.js v5's `next-auth` re-exports Session/User/JWT from "@auth/core", but
// the internal callback signatures (session(), jwt()) reference the
// "@auth/core" types directly — augmenting "next-auth"/"next-auth/jwt" alone
// does not merge into those, so both module specifiers are augmented here.

declare module "@auth/core/types" {
  interface Session {
    user: {
      id: string
      role: Role
    } & DefaultSession["user"]
  }
  interface User {
    role: Role
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role: Role
  }
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      role: Role
    } & DefaultSession["user"]
  }
  interface User {
    role: Role
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: Role
  }
}
