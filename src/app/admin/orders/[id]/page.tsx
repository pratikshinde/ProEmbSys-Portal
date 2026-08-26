import Link from "next/link"
import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import MessageThread from "@/components/messaging/message-thread"
import OrderStatusControl from "@/components/admin/order-status-control"
import { asAddressSnapshot, formatAddressSnapshot } from "@/lib/format-address"
import { SOLDER_MASK_SWATCH } from "@/lib/solder-mask-colors"
import { CAM_JOB_SUMMARY_SELECT, toCamJobSummary } from "@/lib/cam-job-summary"
import { CAM_JOB_STATUS_META, type CamJobStatusKey } from "@/lib/cam-job-status"
import { CAM_JOB_HEALTH_META } from "@/lib/cam-job-health"
import { StatusBadge } from "@/components/status-badge"

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const order = await db.order.findUnique({
    where: { id },
    include: { messageThread: true, user: { select: { name: true, email: true } } },
  })
  if (!order) notFound()

  // Every CamJob linked to this order — orderId-linked jobs are visible to
  // staff unconditionally (see cam-job-access.ts's camJobVisibleWhere), and
  // we're already scoped to one specific order here, so this queries
  // directly rather than going through listStaffVisibleCamJobs.
  const linkedJobRows = await db.camJob.findMany({
    where: { orderId: order.id },
    select: { ...CAM_JOB_SUMMARY_SELECT, user: { select: { name: true, email: true } } },
    orderBy: { updatedAt: "desc" },
  })
  const linkedJobs = linkedJobRows.map((r) => ({ ...toCamJobSummary(r), ownerName: r.user.name, ownerEmail: r.user.email }))

  const deliveryAddress = asAddressSnapshot(order.deliveryAddress)
  const billingAddress = asAddressSnapshot(order.billingAddress)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <div className="text-sm text-muted-foreground">Order {order.reference}</div>
        <h1 className="text-2xl font-bold text-foreground">
          {order.widthMm.toString()} × {order.heightMm.toString()} mm · {order.layers} layers
        </h1>
        <div className="text-sm text-muted-foreground">{order.user.name || order.user.email}</div>
        <div className="text-sm text-muted-foreground">
          Placed on{" "}
          {order.createdAt.toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "Asia/Kolkata",
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-5 text-sm">
        <div>
          <span className="text-muted-foreground">Status</span>
          <div className="mt-1">
            <OrderStatusControl orderId={order.id} currentStatus={order.status} />
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Total</span>
          <div className="font-medium text-foreground">₹{Number(order.total).toLocaleString()}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Quantity</span>
          <div className="font-medium text-foreground">{order.qty} pcs</div>
        </div>
        <div>
          <span className="text-muted-foreground">Surface finish</span>
          <div className="font-medium text-foreground">{order.finish}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Solder mask</span>
          <div className="mt-1">
            <span
              className="inline-block rounded-md px-2 py-0.5 text-xs font-semibold"
              style={
                SOLDER_MASK_SWATCH[order.color]
                  ? { backgroundColor: SOLDER_MASK_SWATCH[order.color].bg, color: SOLDER_MASK_SWATCH[order.color].text }
                  : undefined
              }
            >
              {order.color}
            </span>
          </div>
        </div>
        <div>
          <span className="text-muted-foreground">Copper weight</span>
          <div className="font-medium text-foreground">{order.copperWeight}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Board thickness</span>
          <div className="font-medium text-foreground">{order.thickness}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Lead time</span>
          <div className="font-medium text-foreground">{order.express ? "Express (2–3 days)" : "Standard (5–7 days)"}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Delivery format</span>
          <div className="font-medium text-foreground">
            {order.deliveryFormat === "INDIVIDUAL"
              ? "Individual PCBs"
              : order.deliveryFormat === "PANEL_BY_CUSTOMER"
              ? "Panelized (by customer)"
              : "Panelized (by ProPCB)"}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-5 text-sm">
        <span className="text-muted-foreground">Design files</span>
        <div className="mt-1">
          {order.gerberFilePath ? (
            <a href={`/api/orders/${order.id}/file`} className="font-medium text-primary hover:underline">
              Download {order.fileName ?? "Gerber files"}
            </a>
          ) : (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              No Gerber file on record for this order.
            </span>
          )}
        </div>
      </div>

      {(deliveryAddress || billingAddress) && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-5 text-sm">
          {deliveryAddress && (
            <div>
              <span className="text-muted-foreground">Delivery address</span>
              <div className="font-medium text-foreground">{formatAddressSnapshot(deliveryAddress)}</div>
            </div>
          )}
          {billingAddress && (
            <div>
              <span className="text-muted-foreground">Billing address</span>
              <div className="font-medium text-foreground">{formatAddressSnapshot(billingAddress)}</div>
              {billingAddress.gstNumber && (
                <div className="mt-1 text-xs text-muted-foreground">GST: {billingAddress.gstNumber}</div>
              )}
            </div>
          )}
        </div>
      )}

      {linkedJobs.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-5 text-sm">
          <span className="text-muted-foreground">CAM jobs linked to this order</span>
          <div className="mt-3 flex flex-col gap-2">
            {linkedJobs.map((job) => {
              const statusMeta = CAM_JOB_STATUS_META[job.status as CamJobStatusKey] ?? { label: job.status, bg: "rgba(148,163,184,0.15)", text: "#94a3b8" }
              return (
                <Link
                  key={job.id}
                  href={`/panelization?load=${job.id}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 hover:border-primary"
                >
                  <span className="font-medium text-foreground">
                    {job.name}
                    {job.revision && <span className="font-normal text-muted-foreground"> · Rev {job.revision}</span>}
                  </span>
                  <StatusBadge label={statusMeta.label} bg={statusMeta.bg} text={statusMeta.text} />
                  <span title={job.health.reasons.join(" ")}>
                    <StatusBadge label={job.health.label} bg={CAM_JOB_HEALTH_META[job.health.level].bg} text={CAM_JOB_HEALTH_META[job.health.level].text} />
                  </span>
                  <span className="text-xs text-muted-foreground">by {job.ownerName || job.ownerEmail}</span>
                </Link>
              )
            })}
          </div>
        </div>
      ) : (
        order.deliveryFormat === "PANEL_BY_PROPCB" && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-600 dark:text-amber-400">
            This order needs to be panelized by our team before production — use the Panelization tool on the
            uploaded Gerber files, then link the saved CAM job to this order.
          </div>
        )
      )}

      {order.messageThread && <MessageThread threadId={order.messageThread.id} />}
    </div>
  )
}
