import type { Role } from "@prisma/client"

/**
 * Role predicates. The codebase has ~30 inline `role === "ADMIN" || role ===
 * "ENGINEER"` checks; this file does NOT refactor those — it gives the
 * production tracker one clear place for the checks it needs.
 *
 * `OPERATOR` is deliberately a NON-staff role: `isStaff` is false for it, so
 * every existing staff-gated surface (admin area, orders, pricing, CAM jobs,
 * messaging) keeps excluding operators with no change.
 */

export function isStaff(role: Role | string | undefined | null): boolean {
  return role === "ADMIN" || role === "ENGINEER"
}

export function isOperator(role: Role | string | undefined | null): boolean {
  return role === "OPERATOR"
}

/** Who may reach /production/** and /api/production/** — the shop floor plus
 *  staff (staff can view the operator side to help/train). Customers cannot. */
export function canAccessProduction(role: Role | string | undefined | null): boolean {
  return isStaff(role) || isOperator(role)
}
