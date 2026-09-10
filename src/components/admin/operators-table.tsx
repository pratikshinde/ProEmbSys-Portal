"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { toast } from "@/hooks/use-toast"

export interface OperatorRow {
  id: string
  name: string | null
  email: string
  isActive: boolean
  verified: boolean
  createdAt: string
}

export default function OperatorsTable({ initialOperators }: { initialOperators: OperatorRow[] }) {
  const [operators, setOperators] = useState(initialOperators)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function toggleActive(op: OperatorRow, isActive: boolean) {
    setBusyId(op.id)
    try {
      const res = await fetch(`/api/production/operators/${op.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: "Could not update", description: data.error ?? "Please try again." })
        return
      }
      setOperators((prev) => prev.map((o) => (o.id === op.id ? { ...o, isActive: data.isActive } : o)))
    } finally {
      setBusyId(null)
    }
  }

  if (operators.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        No operator accounts yet. Operators sign themselves up at{" "}
        <code className="text-foreground">/operator/register</code> and confirm their email before they can log in.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Email</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Email confirmed</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Registered</th>
            <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody>
          {operators.map((op) => (
            <tr key={op.id} className="border-t border-border">
              <td className="px-4 py-3 text-foreground">{op.name || "—"}</td>
              <td className="px-4 py-3 text-foreground">{op.email}</td>
              <td className="px-4 py-3">
                {op.verified ? (
                  <Badge variant="default">Confirmed</Badge>
                ) : op.isActive ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  <Badge variant="secondary">Pending</Badge>
                )}
              </td>
              <td className="px-4 py-3">
                <Badge variant={op.isActive ? "default" : "secondary"}>
                  {op.isActive ? "Active" : op.verified ? "Deactivated" : "Not yet active"}
                </Badge>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {new Date(op.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
              </td>
              <td className="px-4 py-3 text-right">
                {op.isActive ? (
                  <Button size="sm" variant="outline" disabled={busyId === op.id} onClick={() => toggleActive(op, false)}>
                    Deactivate
                  </Button>
                ) : op.verified ? (
                  <Button size="sm" variant="outline" disabled={busyId === op.id} onClick={() => toggleActive(op, true)}>
                    Reactivate
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">waiting on email</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
