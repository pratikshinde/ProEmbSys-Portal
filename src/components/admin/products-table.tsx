"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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

type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK"

interface ProductRow {
  id: string
  name: string
  description: string | null
  price: number
  category: string
  icon: string
  stockStatus: StockStatus
  isActive: boolean
  sortOrder: number
}

type FormState = {
  name: string
  description: string
  price: string
  category: string
  icon: string
  stockStatus: StockStatus
  isActive: boolean
  sortOrder: string
}
const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  price: "",
  category: "",
  icon: "🔲",
  stockStatus: "IN_STOCK",
  isActive: true,
  sortOrder: "0",
}

const STOCK_LABELS: Record<StockStatus, string> = { IN_STOCK: "In Stock", LOW_STOCK: "Low Stock", OUT_OF_STOCK: "Out of Stock" }

export default function ProductsTable({ initialProducts }: { initialProducts: ProductRow[] }) {
  const [products, setProducts] = useState(initialProducts)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ProductRow | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [deleting, setDeleting] = useState<ProductRow | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  function openEdit(product: ProductRow) {
    setEditing(product)
    setForm({
      name: product.name,
      description: product.description ?? "",
      price: String(product.price),
      category: product.category,
      icon: product.icon,
      stockStatus: product.stockStatus,
      isActive: product.isActive,
      sortOrder: String(product.sortOrder),
    })
    setDialogOpen(true)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const url = editing ? `/api/admin/products/${editing.id}` : "/api/admin/products"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, price: parseFloat(form.price) || 0, sortOrder: parseInt(form.sortOrder, 10) || 0 }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not save product", description: data.error ?? "Please try again." })
        return
      }
      const saved: ProductRow = { ...data, price: Number(data.price) }
      if (editing) {
        setProducts((prev) => prev.map((p) => (p.id === saved.id ? saved : p)))
      } else {
        setProducts((prev) => [...prev, saved])
      }
      setDialogOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  async function onDelete() {
    if (!deleting) return
    const res = await fetch(`/api/admin/products/${deleting.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast({ title: "Could not delete product", description: "Please try again." })
      return
    }
    setProducts((prev) => prev.filter((p) => p.id !== deleting.id))
    setDeleting(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>New Product</Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Product</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Category</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Price</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Stock</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Active</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">
                  <span className="mr-2">{product.icon}</span>
                  {product.name}
                </td>
                <td className="px-4 py-3 text-foreground">{product.category}</td>
                <td className="px-4 py-3 text-foreground">₹{product.price.toLocaleString()}</td>
                <td className="px-4 py-3">
                  <Badge variant={product.stockStatus === "IN_STOCK" ? "default" : "secondary"}>
                    {STOCK_LABELS[product.stockStatus]}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={product.isActive ? "default" : "secondary"}>{product.isActive ? "Active" : "Hidden"}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(product)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleting(product)}>
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                  No products yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit product" : "New product"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="grid grid-cols-[80px_1fr] gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="icon">Icon</Label>
                <Input id="icon" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="price">Price (₹)</Label>
                <Input
                  id="price"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  placeholder="e.g. Microcontroller"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Stock status</Label>
                <Select value={form.stockStatus} onValueChange={(v) => setForm({ ...form, stockStatus: v as StockStatus })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IN_STOCK">In Stock</SelectItem>
                    <SelectItem value="LOW_STOCK">Low Stock</SelectItem>
                    <SelectItem value="OUT_OF_STOCK">Out of Stock</SelectItem>
                  </SelectContent>
                </Select>
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
                Active (visible in the shop)
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
            <AlertDialogTitle>Delete this product?</AlertDialogTitle>
            <AlertDialogDescription>&quot;{deleting?.name}&quot; will be permanently removed.</AlertDialogDescription>
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
