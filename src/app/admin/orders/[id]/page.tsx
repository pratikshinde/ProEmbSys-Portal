import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import MessageThread from "@/components/messaging/message-thread"
import OrderStatusControl from "@/components/admin/order-status-control"

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const order = await db.order.findUnique({
    where: { id },
    include: { messageThread: true, user: { select: { name: true, email: true } } },
  })
  if (!order) notFound()

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
      </div>

      {order.messageThread && <MessageThread threadId={order.messageThread.id} />}
    </div>
  )
}
