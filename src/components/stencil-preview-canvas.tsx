'use client'

/**
 * Stencil aperture preview, shown in the main canvas area instead of the
 * usual Gerber/panel viewer while the Stencil tab is active — same
 * precedent as `array-layout-canvas.tsx` for the G-Code tab's Multi-Panel
 * Array: the underlying board artwork isn't the useful thing to look at
 * here, the actual DXF cut geometry is. Pure SVG, reads `stencilPreview`
 * (geometry, set alongside `stencilFiles` by `generateStencilFilesAction`)
 * rather than re-parsing DXF text.
 *
 * Interactive zoom/pan/fit — scroll wheel to zoom (around the cursor),
 * Alt+drag or middle-click to pan, double-click to re-fit, +/- buttons —
 * the exact same interaction model and transform math as
 * `gerber-viewer.tsx`'s `handleWheel`/`handleMouseMove`/`doZoom`, just
 * seeded from this preview's own ring bounds instead of layer bounds.
 * Content only reflects the LAST GENERATED result (nothing auto-computes
 * on toggle changes, same convention as every other CAM tab), but the view
 * (zoom/pan) is freely interactive on top of that static geometry.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/lib/store'
import type { Point } from '@/lib/stencil-geometry'

const OUTLINE_STROKE = '#4a6f94'
const ORIGINAL_STROKE = '#f59e0b'
const ORIGINAL_FILL = 'rgba(245, 158, 11, 0.08)'
const REDUCED_STROKE = '#0ea5e9'
const REDUCED_FILL = 'rgba(14, 165, 233, 0.28)'
const LABEL_FILL = '#94b8d4'

interface ViewState {
  viewBox: string
  zoom: number
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function ringsBounds(rings: Point[][]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

function polyPoints(ring: Point[]): string {
  return ring.map(p => `${p.x},${p.y}`).join(' ')
}

export default function StencilPreviewCanvas() {
  const stencilPreview = useAppStore(s => s.stencilPreview)
  const stencilConfig = useAppStore(s => s.stencilConfig)
  const stencilGenerating = useAppStore(s => s.stencilGenerating)

  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const isPanningRef = useRef(false)
  const lastMouseRef = useRef({ x: 0, y: 0 })

  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 })
  const [viewState, setViewState] = useState<ViewState>({ viewBox: '0 0 200 200', zoom: 1 })
  const viewStateRef = useRef(viewState)
  useEffect(() => { viewStateRef.current = viewState }, [viewState])

  const { originalRings, reducedRings, outlineRings } = useMemo(
    () => ({
      originalRings: stencilPreview?.originalRings ?? [],
      reducedRings: stencilPreview?.reducedRings ?? [],
      outlineRings: stencilPreview?.outlineRings ?? [],
    }),
    [stencilPreview]
  )

  const bounds = useMemo(
    () => ringsBounds([...outlineRings, ...originalRings, ...reducedRings]),
    [outlineRings, originalRings, reducedRings]
  )

  // Observe the SVG's own wrapper (not the header/footer bars around it), so
  // its content-rect is directly the usable drawing area — no manual bar-
  // height subtraction needed the way gerber-viewer.tsx's single shared
  // container requires.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit to view — mirrors gerber-viewer.tsx's fitToView, but the content is
  // already in Gerber-native Y-up mm drawn under a `scale(1,-1)` group (see
  // the render below), so the fitted viewBox's Y origin is `-(maxY+padding)`
  // instead of `minY-padding` — everything else (uniform scale-to-fit,
  // aspect-ratio letterbox centering) is the identical derivation.
  const fitToView = useCallback(() => {
    if (!bounds) return
    const { w, h } = containerSize
    if (w <= 0 || h <= 0) return

    const padding = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * 0.08
    const contentW = bounds.maxX - bounds.minX + padding * 2
    const contentH = bounds.maxY - bounds.minY + padding * 2
    if (contentW <= 0 || contentH <= 0) return

    const scale = Math.min(w / contentW, h / contentH)
    const scaledW = w / scale
    const scaledH = h / scale
    const offsetX = (scaledW - contentW) / 2
    const offsetY = (scaledH - contentH) / 2

    setViewState({
      viewBox: `${bounds.minX - padding - offsetX} ${-(bounds.maxY + padding) - offsetY} ${scaledW} ${scaledH}`,
      zoom: scale,
    })
  }, [bounds, containerSize])

  // Re-fit whenever a new stencil is generated, or the drawing area resizes
  // (same trigger shape as gerber-viewer.tsx's auto-fit effect).
  useEffect(() => {
    if (bounds) fitToView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stencilPreview, fitToView])

  const parseViewBox = useCallback((vbStr: string) => {
    const parts = vbStr.split(' ').map(Number)
    if (parts.length !== 4 || parts.some(isNaN)) return null
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const vb = parseViewBox(viewStateRef.current.viewBox)
    const { w, h } = containerSize
    if (!vb || w <= 0 || h <= 0) return

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    const zoomFactor = e.deltaY < 0 ? 0.85 : 1.18

    const vbMouseX = vb.x + (mx / w) * vb.w
    const vbMouseY = vb.y + (my / h) * vb.h

    const newW = vb.w * zoomFactor
    const newH = vb.h * zoomFactor

    const newX = vbMouseX - (mx / w) * newW
    const newY = vbMouseY - (my / h) * newH

    setViewState(prev => ({
      ...prev,
      viewBox: `${newX} ${newY} ${newW} ${newH}`,
      zoom: prev.zoom / zoomFactor,
    }))
  }, [containerSize, parseViewBox])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
    // Unlike gerber-viewer.tsx (which always renders one persistent <svg>),
    // this component early-returns an entirely different tree for the
    // loading/empty states — so the <svg> node itself unmounts and remounts
    // across those transitions. `handleWheel`'s identity alone doesn't
    // change on a generating->populated transition (its own deps are
    // unrelated), so without also depending on the mount state here, this
    // effect would skip re-running and silently leave the listener attached
    // to a stale, already-unmounted node — confirmed live: wheel-zoom did
    // nothing after the very first generate, while the +/-/fit buttons
    // (plain onClick, no native-listener/ref timing involved) worked fine.
  }, [handleWheel, stencilGenerating, stencilPreview, bounds])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      isPanningRef.current = true
      lastMouseRef.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanningRef.current) return
    const vb = parseViewBox(viewStateRef.current.viewBox)
    const { w, h } = containerSize
    if (!vb || w <= 0 || h <= 0) return

    const dx = e.clientX - lastMouseRef.current.x
    const dy = e.clientY - lastMouseRef.current.y

    const dvbX = -(dx / w) * vb.w
    const dvbY = -(dy / h) * vb.h

    setViewState(prev => ({
      ...prev,
      viewBox: `${vb.x + dvbX} ${vb.y + dvbY} ${vb.w} ${vb.h}`,
    }))

    lastMouseRef.current = { x: e.clientX, y: e.clientY }
  }, [containerSize, parseViewBox])

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false
  }, [])

  const handleDoubleClick = useCallback(() => {
    fitToView()
  }, [fitToView])

  const doZoom = useCallback((factor: number) => {
    const vb = parseViewBox(viewStateRef.current.viewBox)
    if (!vb) return
    const cx = vb.x + vb.w / 2
    const cy = vb.y + vb.h / 2
    const newW = vb.w * factor
    const newH = vb.h * factor
    setViewState(prev => ({
      ...prev,
      viewBox: `${cx - newW / 2} ${cy - newH / 2} ${newW} ${newH}`,
      zoom: prev.zoom * (1 / factor),
    }))
  }, [parseViewBox])

  if (stencilGenerating) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-[#4a6f94]">
        Generating stencil…
      </div>
    )
  }

  if (!stencilPreview) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-[#4a6f94] text-center px-6">
        No stencil generated yet — click Generate Stencil in the sidebar.
      </div>
    )
  }

  if (!bounds) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-[#4a6f94] text-center px-6">
        Nothing to preview — the selected paste layer(s) produced no apertures.
      </div>
    )
  }

  // Content is drawn in plain Gerber-native (Y-up) terms under this flip —
  // same trick array-layout-canvas.tsx uses. Line/stroke widths are scaled
  // against the CONTENT's own extent (not the current zoomed viewBox), so
  // strokes keep a sensible on-screen thickness rather than growing/shrinking
  // as the user zooms in and out.
  const flipTransform = 'scale(1, -1)'
  const strokeW = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * 0.0025
  const dash = `${strokeW * 4} ${strokeW * 3}`

  return (
    <div className="w-full h-full flex flex-col bg-[#061420]">
      <div className="px-3 py-2 border-b border-[#1a3a5c] text-[10px] font-mono text-[#94b8d4] flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>Scope: {stencilConfig.scope === 'panel' ? 'Whole Panel' : 'Single PCB'}</span>
        <span>Apertures: {reducedRings.length}</span>
        {stencilConfig.reductionPct > 0 && <span>Reduction: {stencilConfig.reductionPct}%</span>}
        <span className="flex items-center gap-3 ml-auto">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: REDUCED_FILL, border: `1px solid ${REDUCED_STROKE}` }} />
            Cut (reduced)
          </span>
          {stencilConfig.reductionPct > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ border: `1px dashed ${ORIGINAL_STROKE}` }} />
              Original pad
            </span>
          )}
          {outlineRings.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ border: `1px dashed ${OUTLINE_STROKE}` }} />
              Outline
            </span>
          )}
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 relative">
        <svg
          ref={svgRef}
          viewBox={viewState.viewBox}
          className="w-full h-full"
          preserveAspectRatio="xMidYMid meet"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
        >
          <g transform={flipTransform}>
            {outlineRings.map((ring, i) => (
              <polygon
                key={`outline-${i}`}
                points={polyPoints(ring)}
                fill="none"
                stroke={OUTLINE_STROKE}
                strokeWidth={strokeW}
                strokeDasharray={dash}
              />
            ))}
            {/* Original (pre-reduction) pad shape only differs from the cut
                geometry when a reduction% was applied — skip drawing an
                exact duplicate on top of itself otherwise. */}
            {stencilConfig.reductionPct > 0 && originalRings.map((ring, i) => (
              <polygon
                key={`original-${i}`}
                points={polyPoints(ring)}
                fill={ORIGINAL_FILL}
                stroke={ORIGINAL_STROKE}
                strokeWidth={strokeW * 0.7}
                strokeDasharray={dash}
              />
            ))}
            {reducedRings.map((ring, i) => (
              <polygon
                key={`reduced-${i}`}
                points={polyPoints(ring)}
                fill={REDUCED_FILL}
                stroke={REDUCED_STROKE}
                strokeWidth={strokeW}
              />
            ))}
          </g>
        </svg>

        {/* Zoom controls — same +/-/fit cluster as gerber-viewer.tsx */}
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button
            onClick={() => doZoom(0.75)}
            className="w-7 h-7 bg-[#0a1e38]/75 hover:bg-[#0f2848] text-[#f0f8ff] rounded flex items-center justify-center text-sm border border-[#1a3a5c] transition-colors"
            title="Zoom in"
          >+</button>
          <button
            onClick={() => doZoom(1.33)}
            className="w-7 h-7 bg-[#0a1e38]/75 hover:bg-[#0f2848] text-[#f0f8ff] rounded flex items-center justify-center text-sm border border-[#1a3a5c] transition-colors"
            title="Zoom out"
          >−</button>
          <button
            onClick={fitToView}
            className="w-7 h-7 bg-[#0a1e38]/75 hover:bg-[#0f2848] text-[#f0f8ff] rounded flex items-center justify-center text-sm border border-[#1a3a5c] transition-colors"
            title="Fit to view"
          >⊞</button>
        </div>
      </div>
      <div className="px-3 py-1.5 border-t border-[#1a3a5c] text-[9px] flex items-center gap-3" style={{ color: LABEL_FILL }}>
        <span>Zoom: {viewState.zoom.toFixed(1)}x</span>
        <span className="text-[#2a4a6a]">Scroll=Zoom Alt+Drag=Pan DblClick=Fit</span>
        <span className="ml-auto">Preview only — reflects the last Generate Stencil click, not live toggle changes.</span>
      </div>
    </div>
  )
}
