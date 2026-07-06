// Real solder-mask swatch colors, keyed off the "color" spec option — shared
// between the PCB Order page's color picker (portal-main.tsx) and the order
// detail pages, so a solder mask color always renders the same way.
export const SOLDER_MASK_SWATCH: Record<string, { bg: string; text: string }> = {
  Green: { bg: "#1f7a3d", text: "#ffffff" },
  Black: { bg: "#1a1a1a", text: "#ffffff" },
  Blue: { bg: "#1857a4", text: "#ffffff" },
  Red: { bg: "#b3261e", text: "#ffffff" },
  White: { bg: "#e8e6df", text: "#1a1a1a" },
  Yellow: { bg: "#d9a91a", text: "#1a1a1a" },
}
