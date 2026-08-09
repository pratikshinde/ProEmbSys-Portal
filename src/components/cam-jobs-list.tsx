"use client"

import { useState } from "react"
import Link from "next/link"
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
import { Button } from "@/components/ui/button"
import { toast } from "@/hooks/use-toast"
import type { CamJobSnapshot } from "@/lib/store"

export interface CamJobRow {
  id: string
  name: string
  updatedAt: string
  config: CamJobSnapshot
}

export default function CamJobsList({ initialJobs }: { initialJobs: CamJobRow[] }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [deleting, setDeleting] = useState<CamJobRow | null>(null)

  async function handleDelete(job: CamJobRow) {
    const res = await fetch(`/api/cam-jobs/${job.id}`, { method: "DELETE" })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast({ title: "Could not delete", description: err.error ?? "Please try again." })
      return
    }
    setJobs((prev) => prev.filter((j) => j.id !== job.id))
    toast({ title: "Job deleted", description: job.name })
  }

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-lg border border-border bg-card p-8">
        <p className="text-muted-foreground">You haven&apos;t saved any CAM jobs yet.</p>
        <Link
          href="/panelization"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          Open the Panelization tool →
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {jobs.map((job) => {
        const designCount = job.config.designs?.length ?? 0
        const layerCount = job.config.files?.length ?? 0
        return (
          <div
            key={job.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary"
          >
            <Link href={`/panelization?load=${job.id}`} className="block flex-1">
              <div className="font-semibold text-foreground">{job.name}</div>
              <div className="text-sm text-muted-foreground">
                {job.config.camMode === "multi" ? "Multi-Design" : "Single Design"} · {designCount} design
                {designCount === 1 ? "" : "s"} · {layerCount} layer{layerCount === 1 ? "" : "s"}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Saved on{" "}
                {new Date(job.updatedAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
              </div>
            </Link>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(job)}>
              Delete
            </Button>
          </div>
        )
      })}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved job and its uploaded files. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) handleDelete(deleting)
                setDeleting(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
