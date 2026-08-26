/**
 * Pure filename-sanitizing helpers, split out of gerber-exporter.ts so
 * src/lib/share/manifest.ts (which builds filenames for the film/drill/test
 * bundles) can use the exact same rules without importing FROM
 * gerber-exporter.ts — which would create a circular import once
 * gerber-exporter.ts imports the manifest builders back. gerber-exporter.ts
 * re-exports both names so every existing import site (store.ts and its
 * own internal use) is unaffected.
 */

/**
 * Sanitize a user-entered PanelInfo field (part number, customer name, etc.)
 * for safe use inside a filename — strips characters invalid on Windows/macOS
 * filesystems and collapses whitespace/repeated separators to a single "_".
 */
export function sanitizeForFilename(value: string | undefined, fallback: string): string {
  const cleaned = (value || '').trim().replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return cleaned || fallback
}

/**
 * Same as `sanitizeForFilename`, plus replaces dots with "V" (e.g. "1.0" ->
 * "1V0"). A revision string is the one field that routinely contains a raw
 * version number — a dot mid-filename reads to Windows Explorer as another
 * extension boundary, which can misdetect/hide the real `.zip`/`.gerber`
 * extension on some configurations. Only applied to `revision`, not the
 * other sanitized fields (customer/PCB name), which don't carry this risk.
 */
export function sanitizeVersionForFilename(value: string | undefined, fallback: string): string {
  return sanitizeForFilename(value, fallback).replace(/\./g, 'V')
}
