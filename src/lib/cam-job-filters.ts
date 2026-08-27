/**
 * The single source of truth for the "My CAM Jobs" list's filter params —
 * shared by the server page (src/app/cam-jobs/page.tsx), the list API route
 * (src/app/api/cam-jobs/route.ts), and the client table
 * (src/components/cam-jobs-library.tsx).
 *
 * Why this exists: before this file, `buildHref` and the "Load more" param
 * builder inside cam-jobs-library.tsx each hand-enumerated the same param
 * names separately. That was survivable at 3 params; growing to Customer/
 * Date/Sort filters makes it a real risk — if "Load more" forgets a param
 * the two builders agree on, it silently fetches from a DIFFERENT filtered
 * result set and appends rows that don't belong, with no error at all. Every
 * consumer now goes through parseCamJobFilters/camJobFiltersToParams/
 * buildCamJobsHref so there is exactly one list of param names to update.
 *
 * Deliberately Prisma-free so it can be imported from the client component
 * — enum/DB validation stays in cam-job-summary.ts, which is server-only.
 */
import { istDateString, istDayStartUtc } from "./ist-date"

export type CamJobSortKey = "name" | "customer" | "status" | "health" | "updatedAt"
export type CamJobSortDir = "asc" | "desc"

/** Column headers' first-click direction — text A→Z, dates newest-first,
 *  status pipeline-order, health worst-first. Starting every column at
 *  "asc" would put the oldest job atop a Saved-date sort and "Clean" atop a
 *  Health sort, which reads as broken even though it's technically ordered. */
export const CAM_JOB_SORT_NATURAL_DIR: Record<CamJobSortKey, CamJobSortDir> = {
  name: "asc",
  customer: "asc",
  status: "asc",
  health: "asc",
  updatedAt: "desc",
}

const VALID_SORT_KEYS: readonly CamJobSortKey[] = ["name", "customer", "status", "health", "updatedAt"]
const VALID_RANGES = ["7d", "30d", "90d"] as const
export type CamJobDateRange = (typeof VALID_RANGES)[number]

export interface CamJobFilters {
  status: string
  health: string
  q: string
  customer: string
  /** "" | "7d" | "30d" | "90d" — mutually exclusive with from/to (see
   *  parseCamJobFilters: a valid range always wins and clears from/to). */
  range: string
  from: string // "YYYY-MM-DD", IST calendar day
  to: string // "YYYY-MM-DD", IST calendar day, inclusive
  sort: CamJobSortKey
  dir: CamJobSortDir
}

export const DEFAULT_SORT: CamJobSortKey = "updatedAt"
export const DEFAULT_DIR: CamJobSortDir = "desc"

export const CAM_JOBS_BASE_PATH = "/cam-jobs"

type FilterSource = URLSearchParams | Record<string, string | string[] | undefined>

function readParam(src: FilterSource, key: string): string {
  if (src instanceof URLSearchParams) return src.get(key) ?? ""
  const v = src[key]
  return typeof v === "string" ? v : ""
}

/** Accepts either a real URLSearchParams (API route) or a plain searchParams
 *  object (the server page's awaited `searchParams` prop) — both call sites
 *  read the exact same param names through the exact same function.
 *
 *  Two rules enforced here, not left to callers:
 *   1. `range` and `from`/`to` are ONE control — a valid `range` drops
 *      `from`/`to`, so the two never silently intersect into an empty table
 *      with both controls looking active.
 *   2. `dir` only ever applies alongside a non-default `sort` — an isolated
 *      `dir` with no `sort` (e.g. a hand-edited URL) falls back to the
 *      default sort/dir pair rather than half-applying.
 */
export function parseCamJobFilters(src: FilterSource): CamJobFilters {
  const rawRange = readParam(src, "range")
  const range = (VALID_RANGES as readonly string[]).includes(rawRange) ? rawRange : ""
  const from = range ? "" : readParam(src, "from")
  const to = range ? "" : readParam(src, "to")

  const rawSort = readParam(src, "sort")
  const sort = (VALID_SORT_KEYS as readonly string[]).includes(rawSort) ? (rawSort as CamJobSortKey) : DEFAULT_SORT
  // An explicit dir wins; otherwise fall back to this column's natural
  // direction — which, for the default sort key, IS DEFAULT_DIR by
  // construction (CAM_JOB_SORT_NATURAL_DIR.updatedAt === "desc"), so a bare
  // `/cam-jobs` and an explicit `?sort=updatedAt&dir=desc` resolve to the
  // exact same filters object.
  const rawDir = readParam(src, "dir")
  const dir: CamJobSortDir = rawDir === "asc" ? "asc" : rawDir === "desc" ? "desc" : CAM_JOB_SORT_NATURAL_DIR[sort]

  return {
    status: readParam(src, "status"),
    health: readParam(src, "health"),
    q: readParam(src, "q"),
    customer: readParam(src, "customer"),
    range,
    from,
    to,
    sort,
    dir,
  }
}

/** The inverse of parseCamJobFilters — only ever emits params for non-
 *  default values, so the common "no filters, default sort" case stays a
 *  bare `/cam-jobs` (and the paramless `GET /api/cam-jobs` the in-tool Load
 *  Job dialog fires keeps meaning exactly "the 20 most recently saved",
 *  unaffected by any of this — see DEFAULT_SORT/DEFAULT_DIR's own docs). */
export function camJobFiltersToParams(f: CamJobFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (f.status) params.set("status", f.status)
  if (f.health) params.set("health", f.health)
  if (f.q) params.set("q", f.q)
  if (f.customer) params.set("customer", f.customer)
  if (f.range) {
    params.set("range", f.range)
  } else {
    if (f.from) params.set("from", f.from)
    if (f.to) params.set("to", f.to)
  }
  if (f.sort !== DEFAULT_SORT || f.dir !== DEFAULT_DIR) {
    params.set("sort", f.sort)
    params.set("dir", f.dir)
  }
  return params
}

/** Builds a `/cam-jobs?...` href from a filter set with one or more fields
 *  overridden — every filter pill, select, date input, and sort header in
 *  the table goes through this so no call site re-derives the param string
 *  by hand. Overriding `range` does NOT automatically clear from/to (a
 *  caller flipping between the two controls should pass both explicitly,
 *  e.g. `{ range: "7d", from: "", to: "" }`) — camJobFiltersToParams still
 *  prefers `range` when both are somehow set, so this can't produce a
 *  broken combined URL, only a slightly redundant one. */
export function buildCamJobsHref(filters: CamJobFilters, overrides: Partial<CamJobFilters>): string {
  const merged = { ...filters, ...overrides }
  const qs = camJobFiltersToParams(merged).toString()
  return qs ? `${CAM_JOBS_BASE_PATH}?${qs}` : CAM_JOBS_BASE_PATH
}

/**
 * Resolves `range`/`from`/`to` into a Prisma-ready half-open UTC window,
 * IST calendar days: `[gte, lt)`. `lt` is the START of the day AFTER the
 * window closes rather than `lte` = 23:59:59.999 — that removes the whole
 * millisecond-boundary bug class entirely (adding exactly 24h is safe here
 * only because IST has no DST). Returns `{}` when no date filter is active.
 */
export function resolveDateWindow(f: CamJobFilters, now: Date = new Date()): { gte?: Date; lt?: Date } {
  if (f.range) {
    const days = f.range === "7d" ? 7 : f.range === "30d" ? 30 : 90
    const todayStart = istDayStartUtc(istDateString(now))
    const gte = new Date(todayStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
    const lt = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)
    return { gte, lt }
  }
  if (f.from || f.to) {
    return {
      ...(f.from ? { gte: istDayStartUtc(f.from) } : {}),
      // `to` is inclusive of that whole IST day, so the exclusive bound is
      // the START of the NEXT day.
      ...(f.to ? { lt: new Date(istDayStartUtc(f.to).getTime() + 24 * 60 * 60 * 1000) } : {}),
    }
  }
  return {}
}
