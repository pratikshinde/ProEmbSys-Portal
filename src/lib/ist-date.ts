// The one IST date definition in the repo — order-reference.ts's istPeriod
// used to carry its own copy of this formatter; extracted here so a second
// caller (the CAM job library's date filter) doesn't grow a second,
// possibly-drifting definition of "what day is it in India".

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** "YYYY-MM-DD" for the given instant, in India Standard Time — the business
 *  operates out of Bangalore, so "today" should follow IST, not the server's
 *  (likely UTC) local time or the client's timezone. en-CA formats as
 *  YYYY-MM-DD directly, no manual reassembly needed. */
export function istDateString(date: Date): string {
  return IST_DATE_FORMATTER.format(date)
}

/**
 * The instant that IST midnight of the given "YYYY-MM-DD" day corresponds to
 * in UTC — i.e. the start of that IST calendar day, as a real `Date`. IST is
 * UTC+5:30 with no DST, so IST midnight is always UTC 18:30 the PREVIOUS
 * calendar day; encoding that fixed offset directly avoids re-deriving it
 * (or getting it wrong) at every call site that needs a day-boundary filter.
 */
export function istDayStartUtc(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00+05:30`)
}
