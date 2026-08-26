// Server-safe colored status pill — the shared presentational primitive
// behind every status-meta-map display in the app (Order, CamJob status,
// CamJob health, shop orders, ...). Each domain keeps its own `*Meta()`
// lookup (order-status.ts, cam-job-status.ts, cam-job-health.ts) since the
// label/color RULES differ per domain; only the rendering is shared.
export function StatusBadge({
  label,
  bg,
  text,
  className = "",
}: {
  label: string
  bg: string
  text: string
  className?: string
}) {
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${className}`}
      style={{ backgroundColor: bg, color: text }}
    >
      {label}
    </span>
  )
}
