"use client"

import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { toast } from "@/hooks/use-toast"
import type { ContactRecord } from "./contact-list"

const schema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  company: z.string().optional(),
  role: z.string().optional(),
  notes: z.string().optional(),
  scope: z.enum(["PRIVATE", "SHARED"]),
})
type FormValues = z.infer<typeof schema>

export default function ContactDialog({
  contact,
  isStaff,
  open,
  onOpenChange,
  onSaved,
}: {
  contact: ContactRecord | null
  /** Only staff may create a SHARED (org-wide) contact — the scope picker
   *  only renders for them, and only when adding (scope is immutable on
   *  edit, same convention Address's own `type` field already follows). */
  isStaff: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (contact: ContactRecord) => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { scope: "PRIVATE" },
  })

  useEffect(() => {
    if (!open) return
    reset(
      contact
        ? {
            name: contact.name,
            email: contact.email,
            company: contact.company ?? "",
            role: contact.role ?? "",
            notes: contact.notes ?? "",
            scope: contact.scope,
          }
        : { name: "", email: "", company: "", role: "", notes: "", scope: "PRIVATE" }
    )
  }, [open, contact, reset])

  async function onSubmit(values: FormValues) {
    setSubmitting(true)
    try {
      const url = contact ? `/api/contacts/${contact.id}` : "/api/contacts"
      const method = contact ? "PATCH" : "POST"
      // scope is only ever sent on CREATE — PATCH's route doesn't accept it
      // (immutable after creation, same as Address's `type`).
      const body = contact ? { ...values, scope: undefined } : values
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast({ title: "Could not save contact", description: err.error ?? "Please try again." })
        return
      }
      const saved: ContactRecord = await res.json()
      onSaved(saved)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{contact ? "Edit" : "Add"} contact</DialogTitle>
          <DialogDescription>
            Saved recipients you can send film, drill, or test files to from the CAM tool&apos;s Sharing tab.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...register("email")} />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="company">Company (optional)</Label>
              <Input id="company" {...register("company")} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role">Role (optional)</Label>
              <Input id="role" placeholder="e.g. Film plotter" {...register("role")} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input id="notes" {...register("notes")} />
          </div>
          {isStaff && !contact && (
            <div className="flex flex-col gap-1.5">
              <Label>Visibility</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={watch("scope") === "PRIVATE" ? "default" : "outline"}
                  onClick={() => setValue("scope", "PRIVATE")}
                >
                  Only me
                </Button>
                <Button
                  type="button"
                  variant={watch("scope") === "SHARED" ? "default" : "outline"}
                  onClick={() => setValue("scope", "SHARED")}
                >
                  Shared (all staff)
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Shared contacts are visible to every staff member, never to customers.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
