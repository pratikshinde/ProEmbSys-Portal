"use client"

import { useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { Send, Loader2 } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/hooks/use-toast"

interface Operator {
  id: string
  name: string
}

/** "Send to Fab" — hands the current computed panel (summary + rendered image)
 *  to a shop-floor operator. Only visible to staff, only when a panel exists. */
export default function SendToFabButton() {
  const { data: session } = useSession()
  const panelResult = useAppStore((s) => s.panelResult)
  const panelConfig = useAppStore((s) => s.panelConfig)
  const panelInfo = useAppStore((s) => s.panelInfo)
  const targetUnit = useAppStore((s) => s.targetUnit)
  const lastSavedJobId = useAppStore((s) => s.lastSavedJobId)

  const [open, setOpen] = useState(false)
  const [operators, setOperators] = useState<Operator[]>([])
  const [operatorId, setOperatorId] = useState("")
  const [priority, setPriority] = useState<"LOW" | "NORMAL" | "HIGH" | "RUSH">("NORMAL")
  const [dueDate, setDueDate] = useState("")
  const [notes, setNotes] = useState("")
  const [sending, setSending] = useState(false)

  const role = session?.user?.role
  const isStaff = role === "ADMIN" || role === "ENGINEER"

  useEffect(() => {
    if (!open) return
    fetch("/api/production/operators")
      .then((r) => (r.ok ? r.json() : { operators: [] }))
      .then((d) => {
        setOperators(d.operators || [])
        if (d.operators?.length === 1) setOperatorId(d.operators[0].id)
      })
      .catch(() => {})
  }, [open])

  if (!isStaff || !panelResult) return null

  async function send() {
    if (!operatorId) {
      toast({ title: "Pick an operator first" })
      return
    }
    const svgEl = document.querySelector("[data-panel-svg]")
    if (!svgEl) {
      toast({ title: "Couldn't capture the panel image", description: "Make sure the panel is showing in the viewer." })
      return
    }
    setSending(true)
    try {
      const panelSvg = new XMLSerializer().serializeToString(svgEl)
      const pr = panelResult!
      const panelSummary = {
        pcbWidthMm: pr.designs[0]?.widthMm ?? null,
        pcbHeightMm: pr.designs[0]?.heightMm ?? null,
        panelWidthMm: pr.panelWidth ?? null,
        panelHeightMm: pr.panelHeight ?? null,
        totalPcbs: pr.totalPCBs ?? 0,
        rows: panelConfig.rows ?? null,
        cols: panelConfig.cols ?? null,
        toolingHoles: (pr.toolingHoles || []).filter((h) => h.type === "tooling").length,
        referenceHoles: (pr.toolingHoles || []).filter((h) => h.type === "reference").length,
        fiducials: (pr.fiducials || []).length,
        unit: targetUnit,
      }

      const res = await fetch("/api/production/send-to-fab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorId,
          priority,
          dueDate: dueDate ? new Date(dueDate).toISOString() : null,
          notes: notes.trim() || null,
          boardName: panelInfo.pcbName?.trim() || null,
          orderReference: panelInfo.customerRef?.trim() || null,
          camJobId: lastSavedJobId || null,
          quantity: panelSummary.totalPcbs || 1,
          panelSummary,
          panelSvg,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not send", description: data.error ?? "Please try again." })
        return
      }
      const opName = operators.find((o) => o.id === operatorId)?.name ?? "the operator"
      toast({ title: `Sent to ${opName}`, description: `${data.reference} is now in their queue.` })
      setOpen(false)
      setNotes("")
    } catch (err) {
      toast({ title: "Could not send", description: err instanceof Error ? err.message : "Please try again." })
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="w-full bg-emerald-500 hover:bg-emerald-500/90 text-white h-9 text-sm font-semibold"
      >
        <Send className="w-4 h-4 mr-1.5" />
        Send to Fab
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send this panel to the shop floor</DialogTitle>
            <DialogDescription>
              The operator gets the panel summary, a picture of the panel, and the manufacturing checklist.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              {panelResult && (
                <>
                  Panel {panelResult.panelWidth?.toFixed(1)} × {panelResult.panelHeight?.toFixed(1)} {targetUnit} ·{" "}
                  {panelResult.totalPCBs} PCBs · {panelConfig.rows}×{panelConfig.cols}
                </>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Operator</Label>
              <Select value={operatorId} onValueChange={setOperatorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an operator" />
                </SelectTrigger>
                <SelectContent>
                  {operators.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {operators.length === 0 && (
                <p className="text-xs text-amber-500">
                  No operator accounts yet — add one in Admin → Team &amp; Operators.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="NORMAL">Normal</SelectItem>
                    <SelectItem value="HIGH">Urgent</SelectItem>
                    <SelectItem value="RUSH">Rush</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stf-due">Due date</Label>
                <Input id="stf-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="stf-notes">Notes for the operator (optional)</Label>
              <Input
                id="stf-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. 2oz copper on power layers"
              />
            </div>
          </div>

          <DialogFooter>
            <Button onClick={send} disabled={sending || !operatorId}>
              {sending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Send className="w-4 h-4 mr-1.5" />}
              Send to Fab
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
