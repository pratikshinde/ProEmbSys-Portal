"use client"

import { useState } from "react"
import { Plus, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import ContactDialog from "./contact-dialog"

export interface ContactRecord {
  id: string
  scope: "PRIVATE" | "SHARED"
  name: string
  email: string
  company: string | null
  role: string | null
  notes: string | null
  editable: boolean
}

function ContactRow({ contact, onEdit, onDelete }: { contact: ContactRecord; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-start justify-between rounded-lg border border-border bg-card p-4">
      <div className="text-sm">
        <div className="flex items-center gap-2 font-medium text-foreground">
          {contact.name}
          {contact.scope === "SHARED" && <Badge variant="secondary">Shared</Badge>}
        </div>
        <div className="mt-1 text-muted-foreground">{contact.email}</div>
        {(contact.company || contact.role) && (
          <div className="mt-1 text-muted-foreground">
            {[contact.role, contact.company].filter(Boolean).join(" · ")}
          </div>
        )}
        {contact.notes && <div className="mt-1 text-xs text-muted-foreground">{contact.notes}</div>}
      </div>
      {contact.editable && (
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" title="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" title="Delete" onClick={onDelete}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

export default function ContactList({
  contacts,
  isStaff,
  onChange,
}: {
  contacts: ContactRecord[]
  isStaff: boolean
  onChange: (contacts: ContactRecord[]) => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ContactRecord | null>(null)
  const [deleting, setDeleting] = useState<ContactRecord | null>(null)

  function handleSaved(saved: ContactRecord) {
    const isNew = !contacts.some((c) => c.id === saved.id)
    onChange(isNew ? [...contacts, saved] : contacts.map((c) => (c.id === saved.id ? saved : c)))
  }

  async function handleDelete() {
    if (!deleting) return
    const res = await fetch(`/api/contacts/${deleting.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast({ title: "Could not delete contact", description: "Please try again." })
      return
    }
    onChange(contacts.filter((c) => c.id !== deleting.id))
    setDeleting(null)
  }

  // Shared contacts are the org's own curated list — surfaced as a separate
  // section (only ever non-empty for staff, since visibleContactsWhere
  // excludes SHARED entirely for customers) so it doesn't read as "your own
  // contact list has entries you didn't add".
  const shared = contacts.filter((c) => c.scope === "SHARED")
  const own = contacts.filter((c) => c.scope === "PRIVATE")

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Contacts</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="size-4" /> Add contact
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Saved recipients for the CAM tool&apos;s Sharing tab — film plotters, drill shops, test houses.
      </p>

      {shared.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">Shared (all staff)</h3>
          {shared.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              onEdit={() => {
                setEditing(contact)
                setDialogOpen(true)
              }}
              onDelete={() => setDeleting(contact)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {shared.length > 0 && <h3 className="text-sm font-medium text-muted-foreground">Mine</h3>}
        {own.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts saved yet.</p>
        ) : (
          own.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              onEdit={() => {
                setEditing(contact)
                setDialogOpen(true)
              }}
              onDelete={() => setDeleting(contact)}
            />
          ))
        )}
      </div>

      <ContactDialog contact={editing} isStaff={isStaff} open={dialogOpen} onOpenChange={setDialogOpen} onSaved={handleSaved} />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this contact?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.name} ({deleting?.email}) will be permanently removed
              {deleting?.scope === "SHARED" ? " for every staff member" : ""}. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
