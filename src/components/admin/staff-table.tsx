"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import type { Role } from "@prisma/client"

interface StaffMember {
  id: string
  name: string | null
  email: string
  role: Role
  isActive: boolean
  createdAt: string | Date
}

const createSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email"),
  role: z.enum(["ADMIN", "ENGINEER"]),
})
type CreateValues = z.infer<typeof createSchema>

export default function StaffTable({
  initialStaff,
  currentUserId,
}: {
  initialStaff: StaffMember[]
  currentUserId: string
}) {
  const [staff, setStaff] = useState(initialStaff)
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<StaffMember | null>(null)
  const [deactivating, setDeactivating] = useState<StaffMember | null>(null)
  const [createResult, setCreateResult] = useState<{ email: string; tempPassword: string; emailSent: boolean } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", email: "", role: "ENGINEER" },
  })

  async function onCreate(values: CreateValues) {
    setSubmitting(true)
    try {
      const res = await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not create account", description: data.error ?? "Please try again." })
        return
      }
      setStaff((prev) => [...prev, data.user])
      setCreateOpen(false)
      reset()
      setCreateResult({ email: data.user.email, tempPassword: data.tempPassword, emailSent: data.emailSent })
    } finally {
      setSubmitting(false)
    }
  }

  async function onEditSave(values: { name: string; role: "ADMIN" | "ENGINEER" }) {
    if (!editing) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/admin/staff/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not save changes", description: data.error ?? "Please try again." })
        return
      }
      setStaff((prev) => prev.map((s) => (s.id === data.id ? data : s)))
      setEditing(null)
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleActive(member: StaffMember, isActive: boolean) {
    const res = await fetch(`/api/admin/staff/${member.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast({ title: "Could not update account", description: data.error ?? "Please try again." })
      return
    }
    setStaff((prev) => prev.map((s) => (s.id === data.id ? data : s)))
    setDeactivating(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            reset({ name: "", email: "", role: "ENGINEER" })
            setCreateOpen(true)
          }}
        >
          Add Staff
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Email</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Role</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.id} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">
                  {member.name || "—"} {member.id === currentUserId && <span className="text-xs text-muted-foreground">(you)</span>}
                </td>
                <td className="px-4 py-3 text-foreground">{member.email}</td>
                <td className="px-4 py-3 text-foreground">{member.role}</td>
                <td className="px-4 py-3">
                  <Badge variant={member.isActive ? "default" : "secondary"}>
                    {member.isActive ? "Active" : "Deactivated"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(member)}>
                      Edit
                    </Button>
                    {member.isActive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={member.id === currentUserId}
                        onClick={() => setDeactivating(member)}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => toggleActive(member, true)}>
                        Reactivate
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add staff account</DialogTitle>
            <DialogDescription>
              A temporary password will be generated. If email is configured, a welcome message is sent with a link
              to set their own password.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onCreate)} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="staff-name">Name</Label>
              <Input id="staff-name" {...register("name")} />
              {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="staff-email">Email</Label>
              <Input id="staff-email" type="email" {...register("email")} />
              {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Role</Label>
              <Select value={watch("role")} onValueChange={(v) => setValue("role", v as "ADMIN" | "ENGINEER")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ENGINEER">Engineer</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit staff account</DialogTitle>
          </DialogHeader>
          {editing && (
            <EditForm
              member={editing}
              submitting={submitting}
              disableRoleChange={editing.id === currentUserId}
              onSave={onEditSave}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Deactivate confirm */}
      <AlertDialog open={!!deactivating} onOpenChange={(open) => !open && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this account?</AlertDialogTitle>
            <AlertDialogDescription>
              {deactivating?.name || deactivating?.email} won&apos;t be able to log in until reactivated. Their
              message history in shared order threads is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deactivating && toggleActive(deactivating, false)}>
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* One-time credential display after create */}
      <Dialog open={!!createResult} onOpenChange={(open) => !open && setCreateResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Account created</DialogTitle>
            <DialogDescription>
              {createResult?.emailSent
                ? `A welcome email was sent to ${createResult?.email}.`
                : "The welcome email could not be sent (check RESEND_API_KEY). Share this temporary password directly instead."}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted p-3 font-mono text-sm">
            {createResult?.email} / {createResult?.tempPassword}
          </div>
          <p className="text-xs text-muted-foreground">
            This password is shown only once — it won&apos;t be retrievable after you close this dialog.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function EditForm({
  member,
  submitting,
  disableRoleChange,
  onSave,
}: {
  member: StaffMember
  submitting: boolean
  disableRoleChange: boolean
  onSave: (values: { name: string; role: "ADMIN" | "ENGINEER" }) => void
}) {
  const [name, setName] = useState(member.name ?? "")
  const [role, setRole] = useState<"ADMIN" | "ENGINEER">(member.role as "ADMIN" | "ENGINEER")

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ name, role })
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="edit-name">Name</Label>
        <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Role</Label>
        <Select value={role} onValueChange={(v) => setRole(v as "ADMIN" | "ENGINEER")} disabled={disableRoleChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ENGINEER">Engineer</SelectItem>
            <SelectItem value="ADMIN">Admin</SelectItem>
          </SelectContent>
        </Select>
        {disableRoleChange && <p className="text-xs text-muted-foreground">You cannot change your own role.</p>}
      </div>
      <DialogFooter>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  )
}
