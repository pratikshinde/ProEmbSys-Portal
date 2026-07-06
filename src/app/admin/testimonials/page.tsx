import { db } from "@/lib/db"
import TestimonialsTable from "@/components/admin/testimonials-table"

export default async function AdminTestimonialsPage() {
  const testimonials = await db.testimonial.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Testimonials</h1>
      <p className="text-sm text-muted-foreground">Active testimonials appear on the homepage.</p>
      <TestimonialsTable
        initialTestimonials={testimonials.map((t) => ({
          id: t.id,
          customerName: t.customerName,
          customerTitle: t.customerTitle,
          quote: t.quote,
          rating: t.rating,
          isActive: t.isActive,
          sortOrder: t.sortOrder,
        }))}
      />
    </div>
  )
}
