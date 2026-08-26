/**
 * Shared server-side helpers for Contact routes — mirrors
 * src/lib/dfm/templates.ts's shape (DTO + visibility-where helper) but is
 * its OWN file rather than a reuse, because the visibility rule genuinely
 * differs: a DfmTemplate's SHARED row is meant to be publicly readable (so
 * the CAM tool's DFM check works logged-out); a SHARED Contact is an
 * org-wide address-book entry meant only for STAFF to pick when sending
 * fab work out. A customer must never see, or be able to email, another
 * customer's shop contact.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'

export interface ContactDto {
  id: string
  scope: 'PRIVATE' | 'SHARED'
  name: string
  email: string
  company: string | null
  role: string | null
  notes: string | null
  /** True when the current viewer may edit/delete it from this UI. */
  editable: boolean
}

type ContactRow = {
  id: string
  scope: 'PRIVATE' | 'SHARED'
  userId: string | null
  name: string
  email: string
  company: string | null
  role: string | null
  notes: string | null
}

export function toContactDto(row: ContactRow, viewerUserId: string, isStaff: boolean): ContactDto {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    email: row.email,
    company: row.company,
    role: row.role,
    notes: row.notes,
    // A PRIVATE contact is editable by its owner. A SHARED contact is
    // editable by any staff member (org-curated, not personally owned) —
    // matching DfmTemplate's own "SHARED is staff-wide, not per-editor"
    // convention.
    editable: row.scope === 'PRIVATE' ? row.userId === viewerUserId : isStaff,
  }
}

/**
 * Everything the viewer may pick as a share recipient: their own PRIVATE
 * contacts, plus SHARED (org-wide) contacts ONLY if they're staff. A
 * non-staff customer sees and can manage only their own contacts — there is
 * no anonymous/logged-out case at all, unlike DfmTemplate, since sending
 * files requires being signed in in the first place.
 */
export function visibleContactsWhere(viewerUserId: string, isStaff: boolean): Prisma.ContactWhereInput {
  return isStaff
    ? { OR: [{ scope: 'SHARED' }, { scope: 'PRIVATE', userId: viewerUserId }] }
    : { scope: 'PRIVATE', userId: viewerUserId }
}

type Tx = Prisma.TransactionClient | PrismaClient

/** Ownership/edit check for a single contact, mirroring DfmTemplate's
 *  clearOtherDefaults-style shared helper — PRIVATE requires owning it,
 *  SHARED requires being staff. Callers still do their own requireStaff()
 *  gate before calling with isStaff:true for a SHARED write; this is the
 *  read-side check used to decide whether a write is even allowed. */
export function canEditContact(row: { scope: 'PRIVATE' | 'SHARED'; userId: string | null }, viewerUserId: string, isStaff: boolean): boolean {
  return row.scope === 'PRIVATE' ? row.userId === viewerUserId : isStaff
}

export { db }
export type { Tx }
