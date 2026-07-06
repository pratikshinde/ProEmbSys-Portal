import { db } from "@/lib/db"
import BlogTable from "@/components/admin/blog-table"

export default async function AdminBlogPage() {
  const posts = await db.blogPost.findMany({ orderBy: { createdAt: "desc" } })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Blog Posts</h1>
      <p className="text-sm text-muted-foreground">
        Content is written in Markdown. Unpublished posts are only visible here, not on the public blog.
      </p>
      <BlogTable
        initialPosts={posts.map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug,
          excerpt: p.excerpt,
          content: p.content,
          tag: p.tag,
          readMinutes: p.readMinutes,
          published: p.published,
          createdAt: p.createdAt.toISOString(),
        }))}
      />
    </div>
  )
}
