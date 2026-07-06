import { db } from "@/lib/db"
import ProductsTable from "@/components/admin/products-table"

export default async function AdminProductsPage() {
  const products = await db.product.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Shop Products</h1>
      <p className="text-sm text-muted-foreground">
        Products shown here (when active) appear in the Shop and the homepage preview. Icon is a short emoji/glyph,
        matching the shop&apos;s existing visual style.
      </p>
      <ProductsTable
        initialProducts={products.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          price: Number(p.price),
          category: p.category,
          icon: p.icon,
          stockStatus: p.stockStatus,
          isActive: p.isActive,
          sortOrder: p.sortOrder,
        }))}
      />
    </div>
  )
}
