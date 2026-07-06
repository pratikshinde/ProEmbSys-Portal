"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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

interface TestimonialRow {
  id: string
  customerName: string
  customerTitle: string | null
  quote: string
  rating: number
  isActive: boolean
  sortOrder: number
}

type FormState = { customerName: string; customerTitle: string; quote: string; rating: string; isActive: boolean; sortOrder: string }
const EMPTY_FORM: FormState = { customerName: "", customerTitle: "", quote: "", rating: "5", isActive: true, sortOrder: "0" }

export default function TestimonialsTable({ initialTestimonials }: { initialTestimonials: TestimonialRow[] }) {
  const [testimonials, setTestimonials] = useState(initialTestimonials)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TestimonialRow | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [deleting, setDeleting] = useState<TestimonialRow | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  function openEdit(t: TestimonialRow) {
    setEditing(t)
    setForm({
      customerName: t.customerName,
      customerTitle: t.customerTitle ?? "",
      quote: t.quote,
      rating: String(t.rating),
      isActive: t.isActive,
      sortOrder: String(t.sortOrder),
    })
    setDialogOpen(true)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const url = editing ? `/api/admin/testimonials/${editing.id}` : "/api/admin/testimonials"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, rating: parseInt(form.rating, 10) || 5, sortOrder: parseInt(form.sortOrder, 10) || 0 }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not save testimonial", description: data.error ?? "Please try again." })
        return
      }
      if (editing) {
        setTestimonials((prev) => prev.map((t) => (t.id === data.id ? data : t)))
      } else {
        setTestimonials((prev) => [...prev, data])
      }
      setDialogOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  async function onDelete() {
    if (!deleting) return
    const res = await fetch(`/api/admin/testimonials/${deleting.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast({ title: "Could not delete testimonial", description: "Please try again." })
      return
    }
    setTestimonials((prev) => prev.filter((t) => t.id !== deleting.id))
    setDeleting(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>New Testimonial</Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Customer</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Quote</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Rating</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Active</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {testimonials.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">
                  {t.customerName}
                  {t.customerTitle && <div className="text-xs text-muted-foreground">{t.customerTitle}</div>}
                </td>
                <td className="max-w-xs truncate px-4 py-3 text-foreground">{t.quote}</td>
                <td className="px-4 py-3 text-foreground">{"★".repeat(t.rating)}</td>
                <td className="px-4 py-3">
                  <Badge variant={t.isActive ? "default" : "secondary"}>{t.isActive ? "Active" : "Hidden"}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleting(t)}>
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {testimonials.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No testimonials yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit testimonial" : "New testimonial"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customerName">Customer name</Label>
              <Input
                id="customerName"
                value={form.customerName}
                onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customerTitle">Title / company (optional)</Label>
              <Input
                id="customerTitle"
                placeholder="e.g. CTO, Widgets Inc."
                value={form.customerTitle}
                onChange={(e) => setForm({ ...form, customerTitle: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="quote">Quote</Label>
              <Textarea id="quote" rows={4} value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rating">Rating (1-5)</Label>
                <Input
                  id="rating"
                  type="number"
                  min={1}
                  max={5}
                  value={form.rating}
                  onChange={(e) => setForm({ ...form, rating: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sortOrder">Sort order</Label>
                <Input
                  id="sortOrder"
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="isActive"
                checked={form.isActive}
                onCheckedChange={(checked) => setForm({ ...form, isActive: checked === true })}
              />
              <Label htmlFor="isActive" className="font-normal">
                Active (visible on the homepage)
              </Label>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this testimonial?</AlertDialogTitle>
            <AlertDialogDescription>The testimonial from &quot;{deleting?.customerName}&quot; will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
