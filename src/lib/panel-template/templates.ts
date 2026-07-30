/**
 * Shared server-side helpers for PanelTemplate routes — the visibility rule
 * and the `isDefault` bookkeeping live here so the user-facing and admin
 * route trees can't drift apart on either. Mirrors `src/lib/dfm/templates.ts` 1:1.
 */

import type { Prisma, PrismaClient } from "@prisma/client"
import { db } from "@/lib/db"
import { parsePanelTemplateSettingsSafe, type ResolvedPanelTemplateSettings } from "./types"

/** Shape returned to clients — `settings` narrowed back from Prisma's JsonValue. */
export interface PanelTemplateDto {
  id: string
  scope: "PRIVATE" | "SHARED"
  name: string
  settings: ResolvedPanelTemplateSettings
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
  settings: Prisma.JsonValue
  isDefault: boolean
  isSystem: boolean
}

/** A corrupt/legacy `settings` blob falls back to the shop baseline rather
 *  than taking the whole picker down — see parsePanelTemplateSettingsSafe. */
export function toPanelTemplateDto(row: TemplateRow, viewerUserId: string | null): PanelTemplateDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    settings: parsePanelTemplateSettingsSafe(row.settings),
    isDefault: row.isDefault,
    isSystem: row.isSystem,
    // SHARED templates are managed in /admin/panel-templates, never from the
    // customer-facing picker — even for staff, to keep one edit path.
    editable: row.scope === "PRIVATE" && !!viewerUserId && row.userId === viewerUserId,
  }
}

/**
 * Everything the viewer may see: all SHARED templates, plus their own PRIVATE
 * ones when signed in. Anonymous callers get SHARED only — which is what makes
 * the CAM tool's picker usable logged-out.
 */
export function visiblePanelTemplatesWhere(viewerUserId: string | null): Prisma.PanelTemplateWhereInput {
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
export async function clearOtherPanelDefaults(
  tx: Tx,
  scope: "PRIVATE" | "SHARED",
  userId: string | null,
  exceptId?: string
) {
  await tx.panelTemplate.updateMany({
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
