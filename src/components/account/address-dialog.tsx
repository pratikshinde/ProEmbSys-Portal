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
import { Checkbox } from "@/components/ui/checkbox"
import { toast } from "@/hooks/use-toast"
import type { AddressRecord } from "./account-client"

const schema = z.object({
  label: z.string().optional(),
  line1: z.string().min(1, "Address line 1 is required"),
  line2: z.string().optional(),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State is required"),
  postalCode: z.string().min(1, "PIN code is required"),
  country: z.string().min(1, "Country is required"),
  gstNumber: z.string().optional(),
  isDefault: z.boolean(),
})
type FormValues = z.infer<typeof schema>

export default function AddressDialog({
  type,
  address,
  open,
  onOpenChange,
  onSaved,
}: {
  type: "BILLING" | "DELIVERY"
  address: AddressRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (address: AddressRecord) => void
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
    defaultValues: { country: "India", isDefault: false },
  })

  useEffect(() => {
    if (!open) return
    reset(
      address
        ? {
            label: address.label ?? "",
            line1: address.line1,
            line2: address.line2 ?? "",
            city: address.city,
            state: address.state,
            postalCode: address.postalCode,
            country: address.country,
            gstNumber: address.gstNumber ?? "",
            isDefault: address.isDefault,
          }
        : { label: "", line1: "", line2: "", city: "", state: "", postalCode: "", country: "India", gstNumber: "", isDefault: false }
    )
  }, [open, address, reset])

  async function onSubmit(values: FormValues) {
    setSubmitting(true)
    try {
      const url = address ? `/api/account/addresses/${address.id}` : "/api/account/addresses"
      const method = address ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, type }),
      })
      if (!res.ok) {
        toast({ title: "Could not save address", description: "Please try again." })
        return
      }
      const saved: AddressRecord = await res.json()
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
          <DialogTitle>{address ? "Edit" : "Add"} {type === "BILLING" ? "billing" : "delivery"} address</DialogTitle>
          <DialogDescription>
            {type === "BILLING"
              ? "Used for invoicing — include your GST number if this address is GST-registered."
              : "Where fabricated boards should be shipped."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="label">Label (optional)</Label>
            <Input id="label" placeholder="e.g. Head Office" {...register("label")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="line1">Address line 1</Label>
            <Input id="line1" {...register("line1")} />
            {errors.line1 && <p className="text-sm text-destructive">{errors.line1.message}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="line2">Address line 2 (optional)</Label>
            <Input id="line2" {...register("line2")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="city">City</Label>
              <Input id="city" {...register("city")} />
              {errors.city && <p className="text-sm text-destructive">{errors.city.message}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="state">State</Label>
              <Input id="state" {...register("state")} />
              {errors.state && <p className="text-sm text-destructive">{errors.state.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="postalCode">PIN code</Label>
              <Input id="postalCode" {...register("postalCode")} />
              {errors.postalCode && <p className="text-sm text-destructive">{errors.postalCode.message}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="country">Country</Label>
              <Input id="country" {...register("country")} />
            </div>
          </div>
          {type === "BILLING" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gstNumber">GST number (optional)</Label>
              <Input id="gstNumber" placeholder="e.g. 29AAHCP7519H1Z0" {...register("gstNumber")} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="isDefault"
              checked={watch("isDefault")}
              onCheckedChange={(checked) => setValue("isDefault", checked === true)}
            />
            <Label htmlFor="isDefault" className="font-normal">
              Set as default {type === "BILLING" ? "billing" : "delivery"} address
            </Label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save address"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
