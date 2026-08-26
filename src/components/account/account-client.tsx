"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { toast } from "@/hooks/use-toast"
import AddressList from "./address-list"
import ContactList from "../contact-list"
import type { ContactRecord } from "../contact-list"

export interface AddressRecord {
  id: string
  type: "BILLING" | "DELIVERY"
  label: string | null
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
  country: string
  gstNumber: string | null
  isDefault: boolean
}

export default function AccountClient({
  initialName,
  email,
  initialAddresses,
  initialContacts,
  isStaff,
}: {
  initialName: string
  email: string
  initialAddresses: AddressRecord[]
  initialContacts: ContactRecord[]
  isStaff: boolean
}) {
  const [name, setName] = useState(initialName)
  const [savedName, setSavedName] = useState(initialName)
  const [savingName, setSavingName] = useState(false)
  const [addresses, setAddresses] = useState(initialAddresses)
  const [contacts, setContacts] = useState(initialContacts)

  async function saveName() {
    if (!name.trim() || name === savedName) return
    setSavingName(true)
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
    setSavingName(false)
    if (!res.ok) {
      toast({ title: "Could not update name", description: "Please try again." })
      return
    }
    setSavedName(name)
    toast({ title: "Name updated" })
  }

  const billing = addresses.filter((a) => a.type === "BILLING")
  const delivery = addresses.filter((a) => a.type === "DELIVERY")

  function updateType(type: "BILLING" | "DELIVERY", next: AddressRecord[]) {
    setAddresses((prev) => [...prev.filter((a) => a.type !== type), ...next])
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold text-foreground">Profile</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label>Email</Label>
            <Input value={email} disabled />
          </div>
          <Button onClick={saveName} disabled={savingName || !name.trim() || name === savedName}>
            {savingName ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <AddressList type="BILLING" title="Billing Addresses" addresses={billing} onChange={(next) => updateType("BILLING", next)} />

      <AddressList type="DELIVERY" title="Delivery Addresses" addresses={delivery} onChange={(next) => updateType("DELIVERY", next)} />

      <ContactList contacts={contacts} isStaff={isStaff} onChange={setContacts} />
    </div>
  )
}
