"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
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

interface BlogPostRow {
  id: string
  title: string
  slug: string
  excerpt: string
  content: string
  tag: string
  readMinutes: number
  published: boolean
  createdAt: string
}

type FormState = { title: string; excerpt: string; content: string; tag: string; readMinutes: string; published: boolean }
const EMPTY_FORM: FormState = { title: "", excerpt: "", content: "", tag: "", readMinutes: "5", published: true }

export default function BlogTable({ initialPosts }: { initialPosts: BlogPostRow[] }) {
  const [posts, setPosts] = useState(initialPosts)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BlogPostRow | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [deleting, setDeleting] = useState<BlogPostRow | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  function openEdit(post: BlogPostRow) {
    setEditing(post)
    setForm({
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      tag: post.tag,
      readMinutes: String(post.readMinutes),
      published: post.published,
    })
    setDialogOpen(true)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const url = editing ? `/api/admin/blog/${editing.id}` : "/api/admin/blog"
      const method = editing ? "PATCH" : "POST"
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ title: "Could not save post", description: data.error ?? "Please try again." })
        return
      }
      if (editing) {
        setPosts((prev) => prev.map((p) => (p.id === data.id ? { ...p, ...data, createdAt: p.createdAt } : p)))
      } else {
        setPosts((prev) => [{ ...data, createdAt: data.createdAt }, ...prev])
      }
      setDialogOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  async function onDelete() {
    if (!deleting) return
    const res = await fetch(`/api/admin/blog/${deleting.id}`, { method: "DELETE" })
    if (!res.ok) {
      toast({ title: "Could not delete post", description: "Please try again." })
      return
    }
    setPosts((prev) => prev.filter((p) => p.id !== deleting.id))
    setDeleting(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>New Post</Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Title</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tag</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((post) => (
              <tr key={post.id} className="border-t border-border">
                <td className="px-4 py-3 text-foreground">{post.title}</td>
                <td className="px-4 py-3 text-foreground">{post.tag}</td>
                <td className="px-4 py-3">
                  <Badge variant={post.published ? "default" : "secondary"}>
                    {post.published ? "Published" : "Draft"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(post)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleting(post)}>
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {posts.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                  No blog posts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit post" : "New post"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tag">Tag</Label>
                <Input
                  id="tag"
                  placeholder="e.g. Design Tips"
                  value={form.tag}
                  onChange={(e) => setForm({ ...form, tag: e.target.value })}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="readMinutes">Read time (min)</Label>
                <Input
                  id="readMinutes"
                  type="number"
                  min={1}
                  value={form.readMinutes}
                  onChange={(e) => setForm({ ...form, readMinutes: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="excerpt">Excerpt</Label>
              <Textarea
                id="excerpt"
                rows={2}
                value={form.excerpt}
                onChange={(e) => setForm({ ...form, excerpt: e.target.value })}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="content">Content (Markdown)</Label>
              <Textarea
                id="content"
                rows={10}
                className="font-mono text-xs"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                required
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="published"
                checked={form.published}
                onCheckedChange={(checked) => setForm({ ...form, published: checked === true })}
              />
              <Label htmlFor="published" className="font-normal">
                Published (visible on the public blog)
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
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>&quot;{deleting?.title}&quot; will be permanently removed.</AlertDialogDescription>
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
