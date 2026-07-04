/**
 * Client-side quote/order persistence. This is a placeholder until Phase 3
 * adds a real backend (Prisma + API routes) — it lets "Save Quote" and
 * "Place Order" do something meaningful (issue a reference number, persist
 * the request) without pretending there's server-side order intake yet.
 */

export interface SavedQuote {
  id: string
  createdAt: string
  status: 'quote' | 'ordered'
  fileName: string | null
  widthMm: number
  heightMm: number
  layers: string
  qty: number
  finish: string
  color: string
  copperWeight: string
  thickness: string
  express: boolean
  total: number
}

const STORAGE_KEY = 'proembsys_quotes'

export function loadLocalQuotes(): SavedQuote[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveQuoteLocally(quote: Omit<SavedQuote, 'id' | 'createdAt'>): SavedQuote {
  const record: SavedQuote = {
    ...quote,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const existing = loadLocalQuotes()
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([record, ...existing]))
  return record
}
