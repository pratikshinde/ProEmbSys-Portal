import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import MessageThread from "@/components/messaging/message-thread"
import OrderStatusControl from "@/components/admin/order-status-control"
import { asAddressSnapshot, formatAddressSnapshot } from "@/lib/format-address"

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const order = await db.order.findUnique({
    where: { id },
    include: { messageThread: true, user: { select: { name: true, email: true } } },
  })
  if (!order) notFound()

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
          <span className="text-muted-foreground">Copper weight</span>
          <div className="font-medium text-foreground">{order.copperWeight}</div>
        </div>
        <div>
          <span className="text-muted-foreground">Board thickness</span>
          <div className="font-medium text-foreground">{order.thickness}</div>
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

      {order.deliveryFormat === "PANEL_BY_PROPCB" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-600 dark:text-amber-400">
          This order needs to be panelized by our team before production — use the Panelization tool on the
          uploaded Gerber files.
        </div>
      )}

      {order.messageThread && <MessageThread threadId={order.messageThread.id} />}
    </div>
  )
}
