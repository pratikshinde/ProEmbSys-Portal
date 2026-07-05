"use client"

import { useState } from "react"
import { Plus, Pencil, Trash2, Star } from "lucide-react"
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
import AddressDialog from "./address-dialog"
import type { AddressRecord } from "./account-client"

export default function AddressList({
  type,
  title,
  addresses,
  onChange,
}: {
  type: "BILLING" | "DELIVERY"
  title: string
  addresses: AddressRecord[]
  onChange: (addresses: AddressRecord[]) => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AddressRecord | null>(null)
  const [deleting, setDeleting] = useState<AddressRecord | null>(null)

  function handleSaved(saved: AddressRecord) {
    const isNew = !addresses.some((a) => a.id === saved.id)
    let next = isNew ? [...addresses, saved] : addresses.map((a) => (a.id === saved.id ? saved : a))
    if (saved.isDefault) {
      next = next.map((a) => (a.id === saved.id ? a : { ...a, isDefault: false }))
    }
    onChange(next)
  }

  async function handleDelete() {
    if (!deleting) return
    const res = await fetch(`/api/account/addresses/${deleting.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast({ title: "Could not delete address", description: "Please try again." })
      return
    }
    onChange(addresses.filter((a) => a.id !== deleting.id))
    setDeleting(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="size-4" /> Add address
        </Button>
      </div>

      {addresses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {title.toLowerCase()} saved yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {addresses.map((address) => (
            <div key={address.id} className="flex items-start justify-between rounded-lg border border-border bg-card p-4">
              <div className="text-sm">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {address.label || "Address"}
                  {address.isDefault && <Badge>Default</Badge>}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {address.line1}
                  {address.line2 ? `, ${address.line2}` : ""}, {address.city}, {address.state} {address.postalCode},{" "}
                  {address.country}
                </div>
                {address.gstNumber && <div className="mt-1 text-muted-foreground">GST: {address.gstNumber}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                {!address.isDefault && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Set as default"
                    onClick={async () => {
                      const res = await fetch(`/api/account/addresses/${address.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ isDefault: true }),
                      })
                      if (!res.ok) {
                        toast({ title: "Could not update address", description: "Please try again." })
                        return
                      }
                      handleSaved(await res.json())
                    }}
                  >
                    <Star className="size-4" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  title="Edit"
                  onClick={() => {
                    setEditing(address)
                    setDialogOpen(true)
                  }}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button size="icon" variant="ghost" title="Delete" onClick={() => setDeleting(address)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddressDialog type={type} address={editing} open={dialogOpen} onOpenChange={setDialogOpen} onSaved={handleSaved} />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this address?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.label || "This address"} will be permanently removed from your account.
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
