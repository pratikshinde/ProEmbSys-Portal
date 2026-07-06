import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export async function GET() {
  const posts = await db.blogPost.findMany({
    where: { published: true },
    select: { id: true, title: true, slug: true, excerpt: true, tag: true, readMinutes: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  })
  return NextResponse.json(posts)
}
