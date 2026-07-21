'use client'

import React, { useRef, useEffect, useLayoutEffect } from 'react'

/**
 * Inject a raw SVG fragment string as the children of a <g> element.
 * Uses an imperative innerHTML assignment via a ref so we avoid React's
 * raw-html prop. The injected content comes from our own worker (tracespace),
 * never from user-supplied HTML, so XSS is not in scope here.
 *
 * Shared by gerber-viewer.tsx (CAM tool) and board-preview.tsx (PCB Order
 * page) — both composite per-layer worker SVG fragments the same way.
 */
export const RawSvgGroup = React.forwardRef<
  SVGGElement,
  { html: string } & Omit<React.SVGAttributes<SVGGElement>, 'dangerouslySetInnerHTML'>
>(function RawSvgGroup({ html, ...rest }, externalRef) {
  const innerRef = useRef<SVGGElement>(null)
  // useLayoutEffect (not useEffect) so innerHTML lands synchronously before the
  // browser paints — critical when the parent is referenced by <use>, since
  // <use> needs to see the populated content on the same paint frame.
  useLayoutEffect(() => {
    const el = innerRef.current
    if (el && el.innerHTML !== html) el.innerHTML = html
  }, [html])
  useEffect(() => {
    if (typeof externalRef === 'function') externalRef(innerRef.current)
    else if (externalRef) externalRef.current = innerRef.current
  })
  return <g ref={innerRef} {...rest} />
})

/**
 * Same as RawSvgGroup but the injected content's root is a <mask> instead of
 * a <g> — used to reveal a solder-mask-opening-shaped region of another
 * layer's geometry (e.g. exposing true pad color only where a mask opening
 * actually is, see getMaskClipPairs in board-colors.ts). Forces the injected
 * geometry to paint white (`color: '#fff'`, resolved through the fragment's
 * own `fill="currentColor"`) so any inked area counts as visible in the
 * luminance mask, regardless of the layer's normal display color.
 *
 * Deliberately a <mask>, not an SVG <clipPath>: a real Gerber mask layer can
 * carry 1000+ shapes (one per pad on a populated board), and this renderer's
 * <clipPath> silently produces an empty clip region past a few hundred child
 * shapes — reproduced on a real KiCad export where every fiducial's exposed
 * pad vanished. <mask> (luminance/raster-based, not vector path intersection)
 * doesn't hit the same wall at the same size and was verified against the
 * exact file that broke <clipPath>.
 */
export const RawSvgMask = React.forwardRef<
  SVGMaskElement,
  { html: string; id: string } & Omit<React.SVGAttributes<SVGMaskElement>, 'dangerouslySetInnerHTML'>
>(function RawSvgMask({ html, id, ...rest }, externalRef) {
  const innerRef = useRef<SVGMaskElement>(null)
  const groupRef = useRef<SVGGElement>(null)
  useLayoutEffect(() => {
    const el = groupRef.current
    if (el && el.innerHTML !== html) el.innerHTML = html
  }, [html])
  useEffect(() => {
    if (typeof externalRef === 'function') externalRef(innerRef.current)
    else if (externalRef) externalRef.current = innerRef.current
  })
  return (
    <mask ref={innerRef} id={id} {...rest}>
      <g ref={groupRef} style={{ color: '#fff' }} />
    </mask>
  )
})
