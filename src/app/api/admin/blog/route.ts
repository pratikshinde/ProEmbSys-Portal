import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

function slugify(title: string) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function uniqueSlug(title: string) {
  const base = slugify(title) || "post"
  let slug = base
  let n = 1
  while (await db.blogPost.findUnique({ where: { slug } })) {
    n += 1
    slug = `${base}-${n}`
  }
  return slug
}

export async function GET() {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const posts = await db.blogPost.findMany({ orderBy: { createdAt: "desc" } })
  return NextResponse.json(posts)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { title, excerpt, content, tag, readMinutes, published } = await req.json()
  if (!title || !excerpt || !content || !tag) {
    return NextResponse.json({ error: "title, excerpt, content, and tag are required." }, { status: 400 })
  }

  const post = await db.blogPost.create({
    data: {
      title,
      slug: await uniqueSlug(title),
      excerpt,
      content,
      tag,
      readMinutes: Number(readMinutes) || 5,
      published: published !== false,
      authorId: session.user.id,
    },
  })
  return NextResponse.json(post, { status: 201 })
}
