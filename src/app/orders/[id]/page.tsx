import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import MessageThread from "@/components/messaging/message-thread"
import { Navbar } from "@/components/portal-main"
import { asAddressSnapshot, formatAddressSnapshot } from "@/lib/format-address"

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) redirect(`/login?callbackUrl=/orders/${id}`)

  const order = await db.order.findUnique({ where: { id }, include: { messageThread: true } })
  if (!order) notFound()

  const deliveryAddress = asAddressSnapshot(order.deliveryAddress)
  const billingAddress = asAddressSnapshot(order.billingAddress)

  const isStaff = session.user.role === "ADMIN" || session.user.role === "ENGINEER"
  if (!isStaff && order.userId !== session.user.id) notFound() // don't leak existence to non-owners

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
        <div>
          <Link href="/orders" className="text-sm text-muted-foreground hover:text-primary">
            &larr; My Orders
          </Link>
          <div className="mt-2 text-sm text-muted-foreground">Order {order.reference}</div>
          <h1 className="text-2xl font-bold text-foreground">
            {order.widthMm.toString()} × {order.heightMm.toString()} mm · {order.layers} layers
          </h1>
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-5 text-sm">
          <div>
            <span className="text-muted-foreground">Status</span>
            <div className="font-medium text-foreground">{order.status}</div>
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
                ? "Panelized (by you)"
                : "Panelized (by ProPCB)"}
            </div>
          </div>
        </div>

        {order.gerberFilePath && (
          <div className="rounded-lg border border-border bg-card p-5 text-sm">
            <span className="text-muted-foreground">Design files</span>
            <div className="mt-1">
              <a href={`/api/orders/${order.id}/file`} className="font-medium text-primary hover:underline">
                Download {order.fileName ?? "Gerber files"}
              </a>
            </div>
          </div>
        )}

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

        {order.messageThread && <MessageThread threadId={order.messageThread.id} />}
      </div>
    </div>
  )
}
