// Shared between the list API route (src/app/api/cam-jobs/route.ts) and the
// server-rendered library page (src/app/cam-jobs/page.tsx, which queries
// Prisma directly rather than through the route) — both need the exact same
// "row -> summary the UI actually displays" projection, so it lives in one
// place rather than being reimplemented twice and drifting.

import { Prisma, CamJobStatus, type CamJob } from "@prisma/client"
import { db } from "./db"
import { deriveCamJobHealth, HEALTH_SORT_RANK, type CamJobHealth, type CamJobHealthLevel } from "./cam-job-health"
import type { CamJobSortKey, CamJobSortDir } from "./cam-job-filters"
import type { CamJobSnapshot } from "./store"

export interface CamJobSummary {
  id: string
  name: string
  revision: string
  customerRef: string
  status: string
  orderId: string | null
  camMode: "single" | "multi"
  designCount: number
  layerCount: number
  health: CamJobHealth
  /** Panel/PCB size captured once at save time — see CamJob.panelWidthMm's
   *  own schema comment. Null means "never panelized as of the last save",
   *  not zero. */
  panelWidthMm: number | null
  panelHeightMm: number | null
  pcbWidthMm: number | null
  pcbHeightMm: number | null
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
  | "customerRef"
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
  | "panelWidthMm"
  | "panelHeightMm"
  | "pcbWidthMm"
  | "pcbHeightMm"
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
    customerRef: job.customerRef,
    status: job.status,
    orderId: job.orderId,
    camMode: config.camMode ?? "single",
    designCount: config.designs?.length ?? 0,
    layerCount: fileCount,
    health,
    panelWidthMm: job.panelWidthMm,
    panelHeightMm: job.panelHeightMm,
    pcbWidthMm: job.pcbWidthMm,
    pcbHeightMm: job.pcbHeightMm,
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
  customerRef: true,
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
  panelWidthMm: true,
  panelHeightMm: true,
  pcbWidthMm: true,
  pcbHeightMm: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CamJobSelect

export interface ListCamJobsOptions {
  userId: string
  status?: string | null
  health?: CamJobHealthLevel | null
  q?: string | null
  /** Exact match — this value only ever comes from the app's own
   *  listCamJobCustomers() distinct-values list, never free text, so a
   *  substring match could only ever silently over-match ("Radius"
   *  swallowing a future "Radius Labs"). */
  customer?: string | null
  /** Half-open [updatedFrom, updatedBefore) window — see
   *  cam-job-filters.ts's resolveDateWindow, which is what callers build
   *  this from. Kept as plain Dates here rather than re-importing the URL
   *  filter shape, so this function's contract stays "give me a Date range",
   *  not "give me a range token". */
  updatedFrom?: Date | null
  updatedBefore?: Date | null
  sort?: CamJobSortKey
  dir?: CamJobSortDir
  skip?: number
  take?: number
}

// Health is DERIVED (see cam-job-health.ts), not a column, so a health
// filter (or a health SORT — see SORT_SPECS below) can't be pushed into the
// WHERE/ORDER BY clause — it means scanning candidate rows in memory
// instead of true DB-level pagination. Bounded rather than elaborate: a
// single user's job count is realistically dozens to a few hundred, not the
// scale where this would matter.
const HEALTH_SCAN_CAP = 1000

const textCmp = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true })

// Postgres orders an enum by DECLARATION order, not alphabetically, so
// sorting the `status` COLUMN already gives the pipeline order
// (Draft -> Ready -> Sent to fab -> Archived) for free. This mirrors that
// for the in-memory comparator — reorder CamJobStatus in schema.prisma and
// this array must be reordered too, or the two paths disagree.
const STATUS_SORT_ORDER: Record<string, number> = { DRAFT: 0, READY: 1, SENT_TO_FAB: 2, ARCHIVED: 3 }

/**
 * One spec per sortable column, holding BOTH orderings side by side so the
 * DB-paginated fast path and the in-memory scan path can never drift apart
 * — you cannot add a DB ordering here without writing its comparator right
 * next to it.
 *   - `orderBy`: the real Prisma ordering, or `null` when the key isn't a
 *     column at all (health).
 *   - `compare`: the ASCENDING in-memory comparator with the same intent —
 *     only actually reached by the scan path, so it does not need to agree
 *     byte-for-byte with Postgres's own collation (see listCamJobSummaries's
 *     own comment on why that's fine).
 *
 * Every `orderBy` array and every comparator ends in the SAME `id`
 * tiebreaker (never sign-flipped) — that's what makes offset pagination
 * sound. Without it, two rows with an equal sort key can come back in a
 * different order for page 1 vs page 2 of "Load more", silently duplicating
 * one row and skipping another.
 */
interface SortSpec {
  orderBy: ((dir: CamJobSortDir) => Prisma.CamJobOrderByWithRelationInput[]) | null
  compare: (a: CamJobSummary, b: CamJobSummary) => number
}

const SORT_SPECS: Record<CamJobSortKey, SortSpec> = {
  updatedAt: {
    orderBy: (d) => [{ updatedAt: d }, { id: "asc" }],
    compare: (a, b) => a.updatedAt.getTime() - b.updatedAt.getTime(),
  },
  name: {
    orderBy: (d) => [{ name: d }, { id: "asc" }],
    compare: (a, b) => textCmp(a.name, b.name),
  },
  customer: {
    orderBy: (d) => [{ customerRef: d }, { id: "asc" }],
    compare: (a, b) => textCmp(a.customerRef, b.customerRef),
  },
  status: {
    orderBy: (d) => [{ status: d }, { id: "asc" }],
    compare: (a, b) => (STATUS_SORT_ORDER[a.status] ?? 99) - (STATUS_SORT_ORDER[b.status] ?? 99),
  },
  health: {
    // Not expressible in SQL — derived from 8 columns plus
    // config.files.length. Selecting this key forces the scan path.
    orderBy: null,
    compare: (a, b) => HEALTH_SORT_RANK[a.health.level] - HEALTH_SORT_RANK[b.health.level],
  },
}

function comparatorFor(sort: CamJobSortKey, dir: CamJobSortDir) {
  const { compare } = SORT_SPECS[sort]
  const sign = dir === "asc" ? 1 : -1
  return (a: CamJobSummary, b: CamJobSummary) => {
    const primary = compare(a, b)
    if (primary !== 0) return sign * primary
    // Tiebreaker deliberately NOT sign-flipped — it must point the same way
    // regardless of `dir`, exactly like the `{ id: "asc" }` in every
    // `orderBy` array above, or page boundaries would shift when the user
    // toggles a column between ascending and descending.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

/**
 * The one place a CamJob list is queried — shared by the list API route
 * (src/app/api/cam-jobs/route.ts, used by the in-tool "Load Job" dialog)
 * and the server-rendered library page (src/app/cam-jobs/page.tsx), so
 * status/health/customer/date/search/sort filtering can never drift between
 * the two surfaces.
 */
export async function listCamJobSummaries(opts: ListCamJobsOptions): Promise<{ jobs: CamJobSummary[]; total: number }> {
  const take = Math.min(Math.max(opts.take ?? 20, 1), 100)
  const skip = Math.max(opts.skip ?? 0, 0)
  const sortKey: CamJobSortKey = opts.sort && opts.sort in SORT_SPECS ? opts.sort : "updatedAt"
  const dir: CamJobSortDir = opts.dir === "asc" ? "asc" : "desc"

  const where: Prisma.CamJobWhereInput = {
    userId: opts.userId,
    // Object.hasOwn, NOT `in` — CamJobStatus is a plain object literal with
    // a real prototype chain, so `"constructor" in CamJobStatus` is TRUE
    // (verified live) and would push the literal string "constructor" into
    // the WHERE, throwing an unhandled PrismaClientValidationError (a 500)
    // on a request like `?status=constructor`.
    ...(opts.status && Object.hasOwn(CamJobStatus, opts.status) ? { status: opts.status as CamJobStatus } : {}),
    ...(opts.q ? { name: { contains: opts.q, mode: "insensitive" as const } } : {}),
    ...(opts.customer ? { customerRef: opts.customer } : {}),
    ...(opts.updatedFrom || opts.updatedBefore
      ? {
          updatedAt: {
            ...(opts.updatedFrom ? { gte: opts.updatedFrom } : {}),
            ...(opts.updatedBefore ? { lt: opts.updatedBefore } : {}),
          },
        }
      : {}),
  }

  const spec = SORT_SPECS[sortKey]

  // ---- FAST PATH: no health filter, and the requested sort is a real
  // column — Postgres does the ordering AND the pagination, and `total` is
  // a true COUNT(*).
  if (!opts.health && spec.orderBy) {
    const [rows, total] = await Promise.all([
      db.camJob.findMany({ where, select: CAM_JOB_SUMMARY_SELECT, orderBy: spec.orderBy(dir), skip, take }),
      db.camJob.count({ where }),
    ])
    return { jobs: rows.map((r) => toCamJobSummary(r)), total }
  }

  // ---- SCAN PATH: entered iff a health FILTER is active, or the sort key
  // is `health` — both derived, so neither can be pushed into SQL.
  //
  // Candidates are always fetched `updatedAt desc, id asc`, deliberately
  // NOT the requested sort — that fetch order only decides WHICH rows
  // survive HEALTH_SCAN_CAP for a user with more jobs than the cap, and
  // "most recently saved wins" is the least surprising truncation rule.
  // The requested sort is applied afterwards, to the whole surviving set.
  //
  // Text collation is honestly out of scope here: Postgres's collation for
  // `ORDER BY name` is not guaranteed byte-identical to JS `localeCompare`,
  // but a text comparator is only ever reached via THIS scan path — and
  // when it runs, the fast path was never an option for this query in the
  // first place, so no single query ever sees two different orderings. The
  // invariant that matters is per-query determinism and page-to-page
  // stability, not cross-path collation identity.
  const [candidates, dbTotal] = await Promise.all([
    db.camJob.findMany({
      where,
      select: CAM_JOB_SUMMARY_SELECT,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: HEALTH_SCAN_CAP,
    }),
    // When only the SORT (not a health filter) forced this path, `where` is
    // identical to the fast path's, so a real COUNT(*) is both cheap and
    // correct — without it, `total` would silently change just because the
    // user clicked the Health column header.
    opts.health ? Promise.resolve(null) : db.camJob.count({ where }),
  ])

  const filtered = candidates.map((r) => toCamJobSummary(r)).filter((j) => !opts.health || j.health.level === opts.health)
  filtered.sort(comparatorFor(sortKey, dir))

  return { jobs: filtered.slice(skip, skip + take), total: dbTotal ?? filtered.length }
}

export interface CamJobCustomerOption {
  value: string
  count: number
}

/**
 * Distinct customerRef values across ALL of this user's jobs — deliberately
 * NOT narrowed by any other active filter. A self-narrowing facet list is a
 * trap: filtering to Status=Ready would make every customer with no Ready
 * job vanish from the dropdown, so you couldn't switch to them without
 * first clearing Status. Blank customerRef is dropped — "no customer set"
 * is covered by the "Any customer" option, not by a blank entry in the list.
 */
export async function listCamJobCustomers(userId: string): Promise<CamJobCustomerOption[]> {
  const rows = await db.camJob.groupBy({
    by: ["customerRef"],
    where: { userId, customerRef: { not: "" } },
    _count: { _all: true },
    orderBy: { customerRef: "asc" },
  })
  return rows.map((r) => ({ value: r.customerRef, count: r._count._all }))
}
