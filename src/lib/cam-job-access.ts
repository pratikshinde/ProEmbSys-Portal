/**
 * Staff read-access to CamJobs owned by someone else — the one, deliberately
 * late-landing piece of the sharing/job-library plan (see CLAUDE.md's own
 * note: "it is the only irreversible privacy change, and Phases 1-4 need
 * none of it").
 *
 * Rule: staff may READ a job iff they own it, OR it's linked to an Order
 * (orderId != null — the owner made it shop business), OR it has been
 * shared to an org-wide SHARED contact (also the owner making it shop
 * business, just via the other route). Staff never write, never delete,
 * never change status — there is deliberately no writeAccessibleCamJob;
 * every mutating route still goes through loadOwnCamJob in
 * src/app/api/cam-jobs/[id]/route.ts, unchanged.
 *
 * This sits beside (not inside) cam-job-summary.ts's listCamJobSummaries,
 * which stays hardcoded to a single owner's jobs for the personal "My CAM
 * Jobs" library — reusing it here would mean threading a staff/global mode
 * through a function whose one real caller never needs it.
 */
import { Prisma, CamJobStatus } from '@prisma/client'
import { db } from './db'
import { CAM_JOB_SUMMARY_SELECT, toCamJobSummary, type CamJobSummary } from './cam-job-summary'

export function isStaffRole(role: string): boolean {
  return role === 'ADMIN' || role === 'ENGINEER'
}

export function camJobVisibleWhere(viewerUserId: string, isStaff: boolean): Prisma.CamJobWhereInput {
  if (!isStaff) return { userId: viewerUserId }
  return {
    OR: [
      { userId: viewerUserId },
      { orderId: { not: null } },
      { shareBundles: { some: { recipients: { some: { contact: { scope: 'SHARED' } } } } } },
    ],
  }
}

/** Why a job is visible to THIS viewer — 'owner' needs no explanation in the
 *  UI; the other two are exactly the two routes camJobVisibleWhere grants a
 *  non-owner staff member, and are mutually exclusive by construction (a
 *  non-owner match against that OR can only have matched one of the two
 *  non-owner branches, so orderId presence alone disambiguates which). */
export type CamJobVisibilityReason = 'owner' | 'order-link' | 'shared-contact'

export function camJobVisibilityReason(job: { userId: string; orderId: string | null }, viewerUserId: string): CamJobVisibilityReason {
  if (job.userId === viewerUserId) return 'owner'
  if (job.orderId) return 'order-link'
  return 'shared-contact'
}

/**
 * Read-only accessor for a single job, staff-aware. Includes the owning
 * user and linked order (when present) so a caller can render "whose job
 * this is" / "linked to order PCB-..." without a second query — information
 * loadOwnCamJob's owner-only callers (PATCH/DELETE) have no use for, which
 * is why this stays a separate function rather than a parameter added to
 * that one.
 */
export async function loadAccessibleCamJob(id: string, viewerUserId: string, isStaff: boolean) {
  return db.camJob.findFirst({
    where: { id, ...camJobVisibleWhere(viewerUserId, isStaff) },
    include: {
      user: { select: { name: true, email: true } },
      order: { select: { reference: true } },
    },
  })
}

export interface StaffCamJobRow extends CamJobSummary {
  ownerName: string | null
  ownerEmail: string
  orderReference: string | null
  visibilityReason: CamJobVisibilityReason
}

/**
 * The /admin/cam-jobs listing — every job currently visible to staff under
 * camJobVisibleWhere, i.e. every job any staff member has a legitimate
 * reason to see (own jobs included, so an Engineer's own saved jobs show up
 * here too rather than only in their personal "My CAM Jobs" library).
 */
export async function listStaffVisibleCamJobs(viewerUserId: string, status?: string | null): Promise<StaffCamJobRow[]> {
  const where: Prisma.CamJobWhereInput = {
    ...camJobVisibleWhere(viewerUserId, true),
    ...(status && status in CamJobStatus ? { status: status as CamJobStatus } : {}),
  }
  const rows = await db.camJob.findMany({
    where,
    select: {
      ...CAM_JOB_SUMMARY_SELECT,
      userId: true,
      user: { select: { name: true, email: true } },
      order: { select: { reference: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return rows.map((r) => ({
    ...toCamJobSummary(r),
    ownerName: r.user.name,
    ownerEmail: r.user.email,
    orderReference: r.order?.reference ?? null,
    visibilityReason: camJobVisibilityReason(r, viewerUserId),
  }))
}
