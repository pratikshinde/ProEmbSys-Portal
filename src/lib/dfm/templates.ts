/**
 * Shared server-side helpers for DfmTemplate routes — the visibility rule and
 * the `isDefault` bookkeeping live here so the user-facing and admin route
 * trees can't drift apart on either.
 */

import type { Prisma, PrismaClient } from "@prisma/client"
import { db } from "@/lib/db"
import { parseDfmRulesSafe, type DfmRules } from "./types"

/** Shape returned to clients — `rules` narrowed back from Prisma's JsonValue. */
export interface DfmTemplateDto {
  id: string
  scope: "PRIVATE" | "SHARED"
  name: string
  rules: DfmRules
  isDefault: boolean
  isSystem: boolean
  /** True when the current viewer may edit it from the non-admin UI. */
  editable: boolean
}

type TemplateRow = {
  id: string
  scope: "PRIVATE" | "SHARED"
  userId: string | null
  name: string
  rules: Prisma.JsonValue
  isDefault: boolean
  isSystem: boolean
}

/** A corrupt/legacy `rules` blob falls back to the baseline rather than taking
 *  the whole picker down — see parseDfmRulesSafe. */
export function toDfmTemplateDto(row: TemplateRow, viewerUserId: string | null): DfmTemplateDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    rules: parseDfmRulesSafe(row.rules),
    isDefault: row.isDefault,
    isSystem: row.isSystem,
    // SHARED templates are managed in /admin/dfm-templates, never from the
    // customer-facing picker — even for staff, to keep one edit path.
    editable: row.scope === "PRIVATE" && !!viewerUserId && row.userId === viewerUserId,
  }
}

/**
 * Everything the viewer may see: all SHARED templates, plus their own PRIVATE
 * ones when signed in. Anonymous callers get SHARED only — which is what makes
 * the CAM tool's check runnable logged-out.
 */
export function visibleTemplatesWhere(viewerUserId: string | null): Prisma.DfmTemplateWhereInput {
  return viewerUserId
    ? { OR: [{ scope: "SHARED" }, { scope: "PRIVATE", userId: viewerUserId }] }
    : { scope: "SHARED" }
}

type Tx = Prisma.TransactionClient | PrismaClient

/**
 * Clear the previous default before setting a new one. Scope matters:
 * a PRIVATE default is per-owner (like the address book), whereas the SHARED
 * default is global — so unsetting must be scoped the same way or a user could
 * clear someone else's default.
 */
export async function clearOtherDefaults(
  tx: Tx,
  scope: "PRIVATE" | "SHARED",
  userId: string | null,
  exceptId?: string
) {
  await tx.dfmTemplate.updateMany({
    where: {
      scope,
      ...(scope === "PRIVATE" ? { userId } : {}),
      isDefault: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isDefault: false },
  })
}

export { db }
