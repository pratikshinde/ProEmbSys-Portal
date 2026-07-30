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
import type { ResolvedPanelTemplateSettings } from "@/lib/panel-template/types"

export interface PanelTemplateRow {
  id: string
  name: string
  settings: ResolvedPanelTemplateSettings
  isDefault: boolean
  isSystem: boolean
}

/**
 * Deliberately NO settings editor here — rebuilding all ~60 panel/output/
 * routing/G-code/array fields in an admin dialog would duplicate four tabs of
 * existing CAM-tool UI and guarantee drift. Staff author a shared template's
 * actual settings by configuring the CAM tool itself and clicking "Publish as
 * Shared" in the picker there; this table only manages naming, the default
 * pick, and deletion of already-published rows.
 */
export default function PanelTemplatesTable({ initialTemplates }: { initialTemplates: PanelTemplateRow[] }) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PanelTemplateRow | null>(null)
  const [name, setName] = useState("")
  const [isDefault, setIsDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<PanelTemplateRow | null>(null)

  function openEdit(t: PanelTemplateRow) {
    setEditing(t)
    setName(t.name)
    setIsDefault(t.isDefault)
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!editing) return
    if (!name.trim()) {
      toast({ title: "Name required", description: "Give the template a name." })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/panel-templates/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), isDefault }),
      })
      const saved = await res.json()
      if (!res.ok) {
        toast({ title: "Could not save", description: saved.error ?? "Please try again." })
        return
      }
      setTemplates((prev) => {
        const next = prev.map((t) => (t.id === saved.id ? { ...t, name: saved.name, isDefault: saved.isDefault } : t))
        // Only one shared template can be the global default.
        return isDefault ? next.map((t) => (t.id === saved.id ? t : { ...t, isDefault: false })) : next
      })
      setDialogOpen(false)
      toast({ title: "Template updated", description: saved.name })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(t: PanelTemplateRow) {
    const res = await fetch(`/api/admin/panel-templates/${t.id}`, { method: "DELETE" })
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
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Bit</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tab style</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Drill format</th>
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
                <td className="px-4 py-3 text-foreground">{t.settings.routing.bitDiameterMm}mm</td>
                <td className="px-4 py-3 text-foreground">{t.settings.routing.tabStyle}</td>
                <td className="px-4 py-3 text-foreground">
                  {t.settings.panel.drillFormat.integerDigits}:{t.settings.panel.drillFormat.decimalDigits} (
                  {t.settings.panel.drillFormat.unit})
                </td>
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
                  No shared templates yet. Publish one from the CAM tool&apos;s Panel Config tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit shared template</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div>
              <Label>Name</Label>
              <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(v === true)} />
              Use as the default template for everyone
            </label>

            <p className="text-xs text-muted-foreground">
              Settings themselves aren&apos;t edited here — go to the CAM tool, load this template,
              adjust the tabs, and Publish as Shared again with the same name to update it.
            </p>
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
