import { ORDER_PIPELINE, orderPipelineIndex, orderStatusMeta } from "@/lib/order-status"

// Horizontal progress timeline for the customer order-detail page.
// Renders nothing for statuses that aren't on the happy path (QUOTE) and a
// plain cancelled notice for CANCELLED.
export function OrderTimeline({ status }: { status: string }) {
  if (status === "CANCELLED") {
    const meta = orderStatusMeta(status)
    return (
      <div
        className="rounded-lg border border-border p-4 text-sm font-medium"
        style={{ backgroundColor: meta.bg, color: meta.text }}
      >
        This order was cancelled.
      </div>
    )
  }

  const current = orderPipelineIndex(status)
  if (current === -1) return null

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center">
        {ORDER_PIPELINE.map((stage, i) => {
          const done = i < current
          const active = i === current
          return (
            <div key={stage.status} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
                  style={
                    done
                      ? { backgroundColor: "rgba(34,197,94,0.2)", color: "#4ade80" }
                      : active
                      ? { backgroundColor: orderStatusMeta(status).bg, color: orderStatusMeta(status).text, boxShadow: `0 0 0 2px ${orderStatusMeta(status).text}` }
                      : { backgroundColor: "rgba(148,163,184,0.12)", color: "#64748b" }
                  }
                >
                  {done ? "✓" : i + 1}
                </div>
                <div
                  className="whitespace-nowrap text-[11px] font-medium"
                  style={{ color: done ? "#4ade80" : active ? orderStatusMeta(status).text : "#64748b" }}
                >
                  {stage.label}
                </div>
              </div>
              {i < ORDER_PIPELINE.length - 1 && (
                <div
                  className="mx-2 mb-5 h-0.5 flex-1 rounded"
                  style={{ backgroundColor: i < current ? "rgba(34,197,94,0.45)" : "rgba(148,163,184,0.18)" }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
