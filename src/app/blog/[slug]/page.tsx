import { notFound } from "next/navigation"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import { db } from "@/lib/db"
import { Navbar } from "@/components/portal-main"

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = await db.blogPost.findUnique({
    where: { slug },
    include: { author: { select: { name: true } } },
  })
  if (!post || !post.published) notFound()

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-2xl px-6 py-12">
        <Link href="/?page=blog" className="text-sm text-muted-foreground hover:text-primary">
          &larr; Back to Blog
        </Link>
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium">{post.tag}</span>
          <span>·</span>
          <span>{post.createdAt.toLocaleDateString("en-IN", { dateStyle: "long" })}</span>
          <span>·</span>
          <span>{post.readMinutes} min read</span>
        </div>
        <h1 className="mt-3 text-3xl font-bold text-foreground">{post.title}</h1>
        {post.author?.name && <p className="mt-2 text-sm text-muted-foreground">By {post.author.name}</p>}
        <div
          className="mt-8 max-w-none text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-sm [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:mb-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-4 [&_p]:leading-relaxed [&_strong]:font-semibold [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6"
        >
          <ReactMarkdown>{post.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
