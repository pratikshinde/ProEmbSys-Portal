// Shared between the list API route (src/app/api/cam-jobs/route.ts) and the
// server-rendered library page (src/app/cam-jobs/page.tsx, which queries
// Prisma directly rather than through the route) — both need the exact same
// "row -> summary the UI actually displays" projection, so it lives in one
// place rather than being reimplemented twice and drifting.

import { Prisma, CamJobStatus, type CamJob } from "@prisma/client"
import { db } from "./db"
import { deriveCamJobHealth, type CamJobHealth, type CamJobHealthLevel } from "./cam-job-health"
import type { CamJobSnapshot } from "./store"

export interface CamJobSummary {
  id: string
  name: string
  revision: string
  status: string
  orderId: string | null
  camMode: "single" | "multi"
  designCount: number
  layerCount: number
  health: CamJobHealth
  createdAt: Date
  updatedAt: Date
}

/** The exact CamJob columns toCamJobSummary needs — deliberately NOT the
 *  full CamJob row, so both call sites can `select` only these (the whole
 *  point: never ship the full `config` blob just to read three counts out
 *  of it — this still reads `config` itself, since Prisma can't project
 *  fields out of a Json column, but strips it back down to a summary
 *  before it ever leaves this function). */
export type CamJobForSummary = Pick<
  CamJob,
  | "id"
  | "name"
  | "revision"
  | "status"
  | "orderId"
  | "config"
  | "dfmRanAt"
  | "dfmErrors"
  | "dfmWarnings"
  | "dfmLayerCount"
  | "exportRanAt"
  | "exportWarnings"
  | "importWarnings"
  | "createdAt"
  | "updatedAt"
>

export function toCamJobSummary(job: CamJobForSummary): CamJobSummary {
  const config = job.config as unknown as Pick<CamJobSnapshot, "camMode" | "designs" | "files">
  const fileCount = config.files?.length ?? 0

  const health: CamJobHealth = deriveCamJobHealth({
    dfmRanAt: job.dfmRanAt,
    dfmErrors: job.dfmErrors,
    dfmWarnings: job.dfmWarnings,
    dfmLayerCount: job.dfmLayerCount,
    exportRanAt: job.exportRanAt,
    exportWarnings: job.exportWarnings,
    importWarnings: job.importWarnings,
    fileCount,
  })

  return {
    id: job.id,
    name: job.name,
    revision: job.revision,
    status: job.status,
    orderId: job.orderId,
    camMode: config.camMode ?? "single",
    designCount: config.designs?.length ?? 0,
    layerCount: fileCount,
    health,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

/** The list-view projection. Includes `config` (Prisma can't project
 *  fields out of a Json column) but `toCamJobSummary` strips it back down
 *  to a summary before it ever reaches a client — this still fixes the
 *  real perf bug, which was shipping every OTHER column plus the full
 *  config with no `select` at all. */
export const CAM_JOB_SUMMARY_SELECT = {
  id: true,
  name: true,
  revision: true,
  status: true,
  orderId: true,
  config: true,
  dfmRanAt: true,
  dfmErrors: true,
  dfmWarnings: true,
  dfmLayerCount: true,
  exportRanAt: true,
  exportWarnings: true,
  importWarnings: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CamJobSelect

export interface ListCamJobsOptions {
  userId: string
  status?: string | null
  health?: CamJobHealthLevel | null
  q?: string | null
  skip?: number
  take?: number
}

// Health is DERIVED (see cam-job-health.ts), not a column, so a health
// filter can't be pushed into the WHERE clause — it means scanning
// candidate rows in memory instead of true DB-level pagination. Bounded
// rather than elaborate: a single user's job count is realistically dozens
// to a few hundred, not the scale where this would matter.
const HEALTH_SCAN_CAP = 1000

/**
 * The one place a CamJob list is queried — shared by the list API route
 * (src/app/api/cam-jobs/route.ts, used by the in-tool "Load Job" dialog)
 * and the server-rendered library page (src/app/cam-jobs/page.tsx), so
 * status/health/search filtering can never drift between the two surfaces.
 */
export async function listCamJobSummaries(opts: ListCamJobsOptions): Promise<{ jobs: CamJobSummary[]; total: number }> {
  const take = Math.min(Math.max(opts.take ?? 20, 1), 100)
  const skip = Math.max(opts.skip ?? 0, 0)

  const where: Prisma.CamJobWhereInput = {
    userId: opts.userId,
    ...(opts.status && opts.status in CamJobStatus ? { status: opts.status as CamJobStatus } : {}),
    ...(opts.q ? { name: { contains: opts.q, mode: "insensitive" as const } } : {}),
  }

  if (!opts.health) {
    const [rows, total] = await Promise.all([
      db.camJob.findMany({ where, select: CAM_JOB_SUMMARY_SELECT, orderBy: { updatedAt: "desc" }, skip, take }),
      db.camJob.count({ where }),
    ])
    return { jobs: rows.map((r) => toCamJobSummary(r)), total }
  }

  const candidates = await db.camJob.findMany({ where, select: CAM_JOB_SUMMARY_SELECT, orderBy: { updatedAt: "desc" }, take: HEALTH_SCAN_CAP })
  const filtered = candidates.map((r) => toCamJobSummary(r)).filter((j) => j.health.level === opts.health)
  return { jobs: filtered.slice(skip, skip + take), total: filtered.length }
}
