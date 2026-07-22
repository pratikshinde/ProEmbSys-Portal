"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "@/hooks/use-toast"
import { DEFAULT_DFM_RULES, type DfmLimit, type DfmRules } from "@/lib/dfm/types"

export interface DfmTemplateRow {
  id: string
  name: string
  rules: DfmRules
  isDefault: boolean
  isSystem: boolean
}

const LIMIT_FIELDS: { key: keyof DfmRules; label: string; pending?: boolean }[] = [
  { key: "minTraceWidthMm", label: "Min trace width (mm)" },
  { key: "minCopperSpacingMm", label: "Min copper spacing (mm)" },
  { key: "minDrillMm", label: "Min drill diameter (mm)" },
  { key: "minSilkLineWidthMm", label: "Min silkscreen line (mm)" },
  { key: "minAnnularRingMm", label: "Min annular ring (mm)" },
  { key: "minMaskClearanceMm", label: "Min mask clearance (mm)", pending: true },
]

export default function DfmTemplatesTable({ initialTemplates }: { initialTemplates: DfmTemplateRow[] }) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DfmTemplateRow | null>(null)
  const [name, setName] = useState("")
  const [rules, setRules] = useState<DfmRules>(DEFAULT_DFM_RULES)
  const [isDefault, setIsDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<DfmTemplateRow | null>(null)

  function openCreate() {
    setEditing(null)
    setName("")
    setRules(DEFAULT_DFM_RULES)
    setIsDefault(false)
    setDialogOpen(true)
  }

  function openEdit(t: DfmTemplateRow) {
    setEditing(t)
    setName(t.name)
    setRules(t.rules)
    setIsDefault(t.isDefault)
    setDialogOpen(true)
  }

  function setLimit(key: keyof DfmRules, field: "standard" | "advanced", raw: string) {
    if (raw === "" && field === "advanced") {
      setRules((prev) => {
        const next = { ...(prev[key] as DfmLimit) }
        delete next.advanced
        return { ...prev, [key]: next }
      })
      return
    }
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) return
    setRules((prev) => ({ ...prev, [key]: { ...(prev[key] as DfmLimit), [field]: num } }))
  }

  async function handleSave() {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give the template a name." })
      return
    }
    setSaving(true)
    try {
      const url = editing ? `/api/admin/dfm-templates/${editing.id}` : "/api/admin/dfm-templates"
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), rules, isDefault }),
      })
      const saved = await res.json()
      if (!res.ok) {
        toast({ title: "Could not save", description: saved.error ?? "Please try again." })
        return
      }
      setTemplates((prev) => {
        const next = editing ? prev.map((t) => (t.id === saved.id ? saved : t)) : [...prev, saved]
        // Only one shared template can be the global default.
        return isDefault ? next.map((t) => (t.id === saved.id ? t : { ...t, isDefault: false })) : next
      })
      setDialogOpen(false)
      toast({ title: editing ? "Template updated" : "Template created", description: saved.name })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(t: DfmTemplateRow) {
    const res = await fetch(`/api/admin/dfm-templates/${t.id}`, { method: "DELETE" })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast({ title: "Could not delete", description: err.error ?? "Please try again." })
      return
    }
    setTemplates((prev) => prev.filter((x) => x.id !== t.id))
    toast({ title: "Template deleted", description: t.name })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>+ New shared template</Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Min trace</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Min drill</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Max board</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="px-4 py-3 font-medium text-foreground">
                  {t.name}
                  {t.isDefault && <Badge className="ml-2">Default</Badge>}
                  {t.isSystem && (
                    <Badge variant="secondary" className="ml-2">
                      Built-in
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-foreground">{t.rules.minTraceWidthMm.standard}mm</td>
                <td className="px-4 py-3 text-foreground">{t.rules.minDrillMm.standard}mm</td>
                <td className="px-4 py-3 text-foreground">{t.rules.maxBoardMm}mm</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
                    Edit
                  </Button>
                  {/* The built-in baseline stays undeletable so every user —
                      including logged-out ones — always has a template. */}
                  {!t.isSystem && (
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(t)}>
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No shared templates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit shared template" : "New shared template"}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label>Name</Label>
              <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Economy 2-layer" />
            </div>

            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 text-xs text-muted-foreground">
              <span />
              <span className="w-20 text-center">Standard</span>
              <span className="w-20 text-center">Advanced</span>
            </div>
            {LIMIT_FIELDS.map(({ key, label, pending }) => {
              const limit = rules[key] as DfmLimit
              return (
                <div key={String(key)} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                  <Label className="text-sm">
                    {label}
                    {pending && <span className="ml-1 text-xs text-muted-foreground">(not checked yet)</span>}
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="w-20"
                    value={limit.standard}
                    onChange={(e) => setLimit(key, "standard", e.target.value)}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    className="w-20"
                    placeholder="—"
                    value={limit.advanced ?? ""}
                    onChange={(e) => setLimit(key, "advanced", e.target.value)}
                  />
                </div>
              )
            })}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Max board edge (mm)</Label>
                <Input
                  type="number"
                  className="mt-1"
                  value={rules.maxBoardMm}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n > 0) setRules((p) => ({ ...p, maxBoardMm: n }))
                  }}
                />
              </div>
              <div>
                <Label>Max aspect ratio</Label>
                <Input
                  type="number"
                  className="mt-1"
                  value={rules.maxAspectRatio}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n > 0) setRules((p) => ({ ...p, maxAspectRatio: n }))
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Layers (min–max)</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type="number"
                    value={rules.layerRange[0]}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0) setRules((p) => ({ ...p, layerRange: [n, p.layerRange[1]] }))
                    }}
                  />
                  <Input
                    type="number"
                    value={rules.layerRange[1]}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0) setRules((p) => ({ ...p, layerRange: [p.layerRange[0], n] }))
                    }}
                  />
                </div>
              </div>
              <div>
                <Label>Thickness mm (min–max)</Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.1"
                    value={rules.boardThicknessMm[0]}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0)
                        setRules((p) => ({ ...p, boardThicknessMm: [n, p.boardThicknessMm[1]] }))
                    }}
                  />
                  <Input
                    type="number"
                    step="0.1"
                    value={rules.boardThicknessMm[1]}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n) && n > 0)
                        setRules((p) => ({ ...p, boardThicknessMm: [p.boardThicknessMm[0], n] }))
                    }}
                  />
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
              Use as the default template for everyone
            </label>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone currently using this template will fall back to the default. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) handleDelete(deleting)
                setDeleting(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
