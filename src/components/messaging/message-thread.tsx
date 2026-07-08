"use client"

import { useRef, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { ImagePlus, X } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"

interface ThreadMessage {
  id: string
  body: string
  createdAt: string
  authorId: string
  author: { id: string; name: string | null; email: string; role: string }
  attachmentPath: string | null
  attachmentName: string | null
  attachmentType: string | null
}

interface ThreadData {
  id: string
  messages: ThreadMessage[]
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

// Polling-based (no WebSockets) — refetches every 10s while mounted, plus
// an immediate refetch right after sending, via react-query's cache
// invalidation. Simple and reliable for a v1 messaging feature.
export default function MessageThread({ threadId }: { threadId: string }) {
  const { data: session } = useSession()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery<ThreadData>({
    queryKey: ["thread", threadId],
    queryFn: async () => {
      const res = await fetch(`/api/messages/threads/${threadId}`)
      if (!res.ok) throw new Error("Failed to load messages")
      return res.json()
    },
    refetchInterval: 10000,
  })

  const sendMessage = useMutation({
    mutationFn: async ({ body, file }: { body: string; file: File | null }) => {
      const formData = new FormData()
      formData.set("body", body)
      if (file) formData.set("file", file)
      const res = await fetch(`/api/messages/threads/${threadId}`, { method: "POST", body: formData })
      if (!res.ok) throw new Error("Failed to send message")
      return res.json()
    },
    onSuccess: () => {
      setDraft("")
      setFile(null)
      queryClient.invalidateQueries({ queryKey: ["thread", threadId] })
    },
  })

  function handlePickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0]
    e.target.value = "" // allow picking the same file again after removing it
    if (!picked) return
    if (!picked.type.startsWith("image/")) {
      setFileError("Only image attachments are allowed.")
      return
    }
    if (picked.size > MAX_ATTACHMENT_BYTES) {
      setFileError("Attachment must be under 5MB.")
      return
    }
    setFileError(null)
    setFile(picked)
  }

  function handleSend() {
    if (!draft.trim() && !file) return
    sendMessage.mutate({ body: draft, file })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="text-sm font-semibold text-foreground">Messages</div>
      <ScrollArea className="h-64 rounded-md border border-border p-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.messages.length ? (
          <p className="text-sm text-muted-foreground">No messages yet — ask a question about this order below.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {data.messages.map((m) => {
              const isMine = m.authorId === session?.user?.id
              const attachmentUrl = m.attachmentPath ? `/api/messages/attachments/${m.attachmentPath}` : null
              return (
                <div key={m.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      isMine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    {attachmentUrl && (
                      <a href={attachmentUrl} target="_blank" rel="noreferrer" className="mb-1 block">
                        {/* eslint-disable-next-line @next/next/no-img-element -- private, auth-gated image, not an optimizable static asset */}
                        <img
                          src={attachmentUrl}
                          alt={m.attachmentName ?? "Attachment"}
                          className="max-h-48 max-w-full rounded-md border border-border/50"
                        />
                      </a>
                    )}
                    {m.body && <span>{m.body}</span>}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {m.author.name || m.author.email} · {new Date(m.createdAt).toLocaleString()}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {file && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
          <ImagePlus className="size-4 shrink-0" />
          <span className="flex-1 truncate">{file.name}</span>
          <button type="button" onClick={() => setFile(null)} aria-label="Remove attachment" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
      )}
      {fileError && <p className="text-xs text-destructive">{fileError}</p>}

      <div className="flex gap-2">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickFile} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          title="Attach a screenshot"
          aria-label="Attach a screenshot"
        >
          <ImagePlus className="size-4" />
        </Button>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          className="min-h-[44px] flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <Button onClick={handleSend} disabled={sendMessage.isPending || (!draft.trim() && !file)}>
          Send
        </Button>
      </div>
    </div>
  )
}
