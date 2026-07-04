"use client"

import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"

interface ThreadMessage {
  id: string
  body: string
  createdAt: string
  authorId: string
  author: { id: string; name: string | null; email: string; role: string }
}

interface ThreadData {
  id: string
  messages: ThreadMessage[]
}

// Polling-based (no WebSockets) — refetches every 10s while mounted, plus
// an immediate refetch right after sending, via react-query's cache
// invalidation. Simple and reliable for a v1 messaging feature.
export default function MessageThread({ threadId }: { threadId: string }) {
  const { data: session } = useSession()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState("")

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
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/messages/threads/${threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) throw new Error("Failed to send message")
      return res.json()
    },
    onSuccess: () => {
      setDraft("")
      queryClient.invalidateQueries({ queryKey: ["thread", threadId] })
    },
  })

  function handleSend() {
    if (!draft.trim()) return
    sendMessage.mutate(draft)
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
              return (
                <div key={m.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      isMine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    {m.body}
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
      <div className="flex gap-2">
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
        <Button onClick={handleSend} disabled={sendMessage.isPending || !draft.trim()}>
          Send
        </Button>
      </div>
    </div>
  )
}
