'use client'

import React, { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react'
import { useAppStore, getLayerZIndex, isPanelViewTab } from '@/lib/store'
import { mergeLayerBounds, GerberSvgResult } from '@/lib/gerber-svg'
import { PanelResult, isRectangularOutline } from '@/lib/panelization-engine'
import { getRegionTextPolygons } from '@/lib/region-font'
import { BOARD_COLOR_NAMES, BOARD_COLOR_PALETTE, EXPOSED_SUBSTRATE_COLOR, getPcbColor, PCB_OPACITY, silkColorFor, getMaskClipPairs } from '@/lib/board-colors'
import { RawSvgGroup, RawSvgMask } from './raw-svg-group'

/**
 * GerberViewer — SVG-based viewer using tracespace-rendered layers (Web Worker).
 *
 * Coordinate system:
 * - The worker outputs SVG in Y-down convention (Y=0 at top = Gerber maxY)
 * - boundsObj is in SVG-native (Y-down screen-space) coordinates
 * - The viewer uses a STANDARD positive-height viewBox
 * - Cursor display converts SVG Y back to Gerber Y by negation
 */

interface ViewState {
  viewBox: string
  zoom: number
}

/**
 * Same as RawSvgGroup but emits a <symbol> — used inside <defs> as the target
 * of <use>. `overflow="visible"` lets the reused content render at its native
 * bounds without needing an explicit viewBox on the symbol.
 */
function RawSvgSymbol({ id, html }: { id: string; html: string }) {
  const ref = useRef<SVGSymbolElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && el.innerHTML !== html) el.innerHTML = html
  }, [html])
  return <symbol ref={ref} id={id} overflow="visible" />
}

export default function GerberViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const layers = useAppStore(s => s.layers)
  const panelResult = useAppStore(s => s.panelResult)
  const panelConfig = useAppStore(s => s.panelConfig)
  const showGrid = useAppStore(s => s.showGrid)
  const showCrosshair = useAppStore(s => s.showCrosshair)
  const targetUnit = useAppStore(s => s.targetUnit)
  const activeTab = useAppStore(s => s.activeTab)
  const boardView = useAppStore(s => s.boardView)
  const boardViewSide = useAppStore(s => s.boardViewSide)
  const viewMode = useAppStore(s => s.viewMode)
  const setViewMode = useAppStore(s => s.setViewMode)
  const setBoardViewSide = useAppStore(s => s.setBoardViewSide)
  const hoveredLayerId = useAppStore(s => s.hoveredLayerId)
  const boardColor = useAppStore(s => s.boardColor)
  const setBoardColor = useAppStore(s => s.setBoardColor)
  const dfmReport = useAppStore(s => s.dfmReport)
  const dfmFocus = useAppStore(s => s.dfmFocus)
  const routingResult = useAppStore(s => s.routingResult)
  const routingFocus = useAppStore(s => s.routingFocus)
  const boardContour = useAppStore(s => s.boardContour)

  const [viewState, setViewState] = useState<ViewState>({ viewBox: '0 0 200 200', zoom: 1 })
  const [cursorPos, setCursorPos] = useState<{ gx: number; gy: number } | null>(null)
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 })

  // Refs for panning
  const isPanningRef = useRef(false)
  const lastMouseRef = useRef({ x: 0, y: 0 })
  const viewStateRef = useRef(viewState)
  useEffect(() => { viewStateRef.current = viewState }, [viewState])

  // Observe container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          w: entry.contentRect.width,
          h: entry.contentRect.height - 28, // subtract status bar height
        })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Board mode is active whenever viewMode === 'board' and we have layers with SVG data
  const isBoardMode =
    viewMode === 'board' &&
    layers.some(l => l.svgData && !l.svgData.isEmpty)

  // Compute combined bounds. In board-view mode the bounds come from
  // tracespace/core's renderBoard viewBox (already in Y-down screen-space).
  // Otherwise fall back to per-layer merged bounds.
  const { combinedBounds, nativeSvgBounds } = useMemo(() => {
    let native: { minX: number; minY: number; maxX: number; maxY: number } | null
    if (isBoardMode && boardView) {
      const vb = boardView.viewBox
      native = {
        minX: vb.x,
        minY: vb.y,
        maxX: vb.x + vb.width,
        maxY: vb.y + vb.height,
      }
    } else {
      const svgLayers = layers.filter(l => l.visible && l.svgData && !l.svgData.isEmpty)
      native = svgLayers.length > 0 ? mergeLayerBounds(svgLayers.map(l => l.svgData!)) : null
    }

    // On panel-view tabs, use panel dimensions for bounds (Y-inverted to match SVG space)
    const combined = (isPanelViewTab(activeTab) && panelResult)
      ? { minX: 0, minY: -panelResult.panelHeight, maxX: panelResult.panelWidth, maxY: 0 }
      : native

    return { combinedBounds: combined, nativeSvgBounds: native }
  }, [layers, activeTab, panelResult, isBoardMode, boardView])

  const boundsCenterX = useMemo(() => {
    if (!combinedBounds) return 0
    return (combinedBounds.minX + combinedBounds.maxX) / 2
  }, [combinedBounds])

  // Screen-space convention: screenY = -gerberY (set by Python transforms)
  // Cursor display: gerberY = -screenY (simple negation, no layer-specific offset needed)

  // Fit to view — standard positive-height viewBox to center content
  const fitToView = useCallback(() => {
    if (!combinedBounds) return

    const padding = 3 // mm padding
    const contentW = combinedBounds.maxX - combinedBounds.minX + padding * 2
    const contentH = combinedBounds.maxY - combinedBounds.minY + padding * 2
    if (contentW <= 0 || contentH <= 0) return

    const { w, h } = containerSize
    if (w <= 0 || h <= 0) return

    // Scale to fit (preserve aspect ratio)
    const scaleX = w / contentW
    const scaleY = h / contentH
    const scale = Math.min(scaleX, scaleY)

    // Standard positive-height viewBox
    const scaledW = w / scale
    const scaledH = h / scale

    // Center content (with aspect-ratio correction)
    const offsetX = (scaledW - contentW) / 2
    const offsetY = (scaledH - contentH) / 2

    setViewState({
      viewBox: `${combinedBounds.minX - padding - offsetX} ${combinedBounds.minY - padding - offsetY} ${scaledW} ${scaledH}`,
      zoom: scale,
    })
  }, [combinedBounds, containerSize])

  // Pan/zoom to a DFM finding or a routing tab when a panel sets a focus point.
  // Both sources are in Gerber-native Y-up mm; this viewer's space is Y-down, so
  // the Y must be negated (screenY = −gerberY) — the same conversion the
  // cursor readout does in reverse. The markers themselves render inside groups
  // that mirror X around boundsCenterX when viewing the bottom side in Board
  // mode (see the dfm-markers / route-overlay <g>s below); this pan-to-marker
  // effect must apply the identical mirror to cx, or it centers the viewport on
  // the unmirrored location while the marker renders at its mirrored one —
  // landing the "zoom to it" window on empty space instead of the marker.
  const focusPoint = dfmFocus ?? routingFocus
  useEffect(() => {
    if (!focusPoint) return
    const { w, h } = containerSize
    if (w <= 0 || h <= 0) return
    // Zoom to a fixed 6mm-wide window so a clearance violation is actually
    // visible rather than a sub-pixel dot.
    const windowMm = 6
    const scale = Math.min(w, h) / windowMm
    const vbW = w / scale
    const vbH = h / scale
    const isBottomBoardView = viewMode === 'board' && boardViewSide === 'bottom' && !!combinedBounds
    const cx = isBottomBoardView ? 2 * boundsCenterX - focusPoint.x : focusPoint.x
    const cy = -focusPoint.y
    setViewState({
      viewBox: `${cx - vbW / 2} ${cy - vbH / 2} ${vbW} ${vbH}`,
      zoom: scale,
    })
  }, [focusPoint, containerSize, viewMode, boardViewSide, combinedBounds, boundsCenterX])

  // Auto-fit when layers change
  useEffect(() => {
    if (layers.length > 0 && combinedBounds) {
      console.log('[GerberViewer] Layers:', layers.length, 'Bounds:', combinedBounds)
      const t = setTimeout(() => {
        fitToView()
        console.log('[GerberViewer] viewBox:', viewStateRef.current.viewBox)
      }, 150)
      return () => clearTimeout(t)
    }
  }, [layers.length, combinedBounds, fitToView])

  // Parse current viewBox into numeric components
  const parseViewBox = useCallback((vbStr: string) => {
    const parts = vbStr.split(' ').map(Number)
    if (parts.length !== 4 || parts.some(isNaN)) return null
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
  }, [])

  // Convert screen coords to Gerber coords
  // Screen space: screenX = gerberX, screenY = -gerberY
  const screenToGerber = useCallback((sx: number, sy: number) => {
    const vb = parseViewBox(viewStateRef.current.viewBox)
    const { w, h } = containerSize
    if (!vb || w <= 0 || h <= 0) return { gx: 0, gy: 0 }

    // Map screen pixel to SVG coordinate
    let svgX = vb.x + (sx / w) * vb.w
    const svgY = vb.y + (sy / h) * vb.h

    // If bottom board view is active, mirror the horizontal coordinate
    const isBottomBoardView = viewMode === 'board' && boardViewSide === 'bottom'
    if (isBottomBoardView && combinedBounds) {
      const boundsCenterX = (combinedBounds.minX + combinedBounds.maxX) / 2
      svgX = 2 * boundsCenterX - svgX
    }

    // Convert screen space to Gerber space: gerberY = -screenY
    return { gx: svgX, gy: -svgY }
  }, [containerSize, parseViewBox, viewMode, boardViewSide, combinedBounds])

  // Mouse wheel zoom
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
  }, [handleWheel])

  // Mouse panning
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      isPanningRef.current = true
      lastMouseRef.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const vb = parseViewBox(viewStateRef.current.viewBox)
    const { w, h } = containerSize
    if (!vb || w <= 0 || h <= 0) return

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    const gp = screenToGerber(sx, sy)
    setCursorPos(gp)

    if (isPanningRef.current) {
      const dx = e.clientX - lastMouseRef.current.x
      const dy = e.clientY - lastMouseRef.current.y

      const dvbX = -(dx / w) * vb.w
      const dvbY = -(dy / h) * vb.h

      setViewState(prev => ({
        ...prev,
        viewBox: `${vb.x + dvbX} ${vb.y + dvbY} ${vb.w} ${vb.h}`,
      }))

      lastMouseRef.current = { x: e.clientX, y: e.clientY }
    }
  }, [containerSize, screenToGerber, parseViewBox])

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

  // Build grid SVG content
  const gridContent = useMemo(() => {
    if (!showGrid || !combinedBounds) return null

    const vb = parseViewBox(viewState.viewBox)
    if (!vb) return null

    // Visible range in SVG coords (standard positive-height viewBox)
    const visMinX = vb.x
    const visMaxX = vb.x + vb.w
    const visMinY = vb.y
    const visMaxY = vb.y + vb.h

    // Adaptive grid spacing
    const targetPixelSpacing = 50
    const spacingEstimate = (vb.w / containerSize.w) * targetPixelSpacing
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(spacingEstimate, 0.001))))
    let niceSpacing: number
    if (spacingEstimate / magnitude < 2) niceSpacing = magnitude
    else if (spacingEstimate / magnitude < 5) niceSpacing = 2 * magnitude
    else niceSpacing = 5 * magnitude

    if (niceSpacing <= 0) return null

    const startX = Math.floor(visMinX / niceSpacing) * niceSpacing
    const endX = Math.ceil(visMaxX / niceSpacing) * niceSpacing
    const startY = Math.floor(visMinY / niceSpacing) * niceSpacing
    const endY = Math.ceil(visMaxY / niceSpacing) * niceSpacing

    const sw = niceSpacing * 0.002
    const lines: React.ReactNode[] = []

    for (let x = startX; x <= endX; x += niceSpacing) {
      lines.push(
        <line key={`v${x}`} x1={x} y1={visMinY} x2={x} y2={visMaxY}
          stroke="rgba(255,255,255,0.06)" strokeWidth={sw} />
      )
    }
    for (let y = startY; y <= endY; y += niceSpacing) {
      lines.push(
        <line key={`h${y}`} x1={visMinX} y1={y} x2={visMaxX} y2={y}
          stroke="rgba(255,255,255,0.06)" strokeWidth={sw} />
      )
    }

    // Axis lines (screen space: screenX=gerberX, screenY=-gerberY)
    // Gerber origin (0,0) is at screen position (0, 0)
    const aw = niceSpacing * 0.005
    lines.push(
      <line key="axX" x1={0} y1={visMinY} x2={0} y2={visMaxY}
        stroke="rgba(255,100,100,0.3)" strokeWidth={aw} />,
      <line key="axY" x1={visMinX} y1={0} x2={visMaxX} y2={0}
        stroke="rgba(100,255,100,0.3)" strokeWidth={aw} />
    )

    return lines
  }, [showGrid, combinedBounds, viewState, containerSize, parseViewBox])

  // Filter visible layers and sort them by PCB stack-up Z-order so silk
  // renders on top of mask, mask on top of copper, drill on top, etc.
  // In Layers overlay mode, hovering a row in the Layers panel isolates that
  // one layer (regardless of its own visibility toggle) so it's easy to see
  // what a single layer contributes; moving the pointer away restores the
  // normal visible-layers view. Board mode composites everything into one
  // substrate render and isn't affected by hover.
  const visibleLayers = useMemo(() => {
    if (viewMode === 'layers' && hoveredLayerId) {
      return layers.filter(l => l.id === hoveredLayerId && l.svgData && !l.svgData.isEmpty)
    }
    return layers
      .filter(l => l.visible && l.svgData && !l.svgData.isEmpty)
      .slice()
      .sort((a, b) => getLayerZIndex(a.type) - getLayerZIndex(b.type))
  }, [layers, viewMode, hoveredLayerId])

  // PCB-realistic colors for board mode compositing (replaces user-configurable colors).
  // Copper tint follows the selected soldermask color (copper as seen through the
  // mask); pad-finish gold stays constant across all mask colors, like a real board.
  // Shared with the PCB Order page's preview via board-colors.ts so the two never drift.
  const copperTint = BOARD_COLOR_PALETTE[boardColor].copperTint
  const silkColor = silkColorFor(boardColor)
  const getBoardLayerColor = (type: string, side: string) => getPcbColor(type, side, copperTint, silkColor)

  // Layers for board mode: filter by selected side, apply PCB colors
  const boardModeLayers = useMemo(() => {
    if (!isBoardMode) return []
    return visibleLayers
      .filter(l => {
        if (l.type === 'fab' || l.type === 'other') return false
        // outline and drill show on both sides
        if (l.type === 'outline' || l.type === 'drill') return true
        // for other types filter by side — 'none' shows on both
        return l.side === boardViewSide || l.side === 'none'
      })
  }, [isBoardMode, visibleLayers, boardViewSide])

  // Check which types of layers are visible for panel overlay decisions
  const visibleLayerTypes = useMemo(() => {
    return new Set(visibleLayers.map(l => l.type))
  }, [visibleLayers])

  // Every location the current DFM report points at, flattened for the marker
  // overlay. Only failing findings carry locations, so passes never clutter the
  // canvas. Coordinates stay in Gerber-native Y-up mm here; the overlay does
  // the Y-down conversion at render time.
  const dfmMarkers = useMemo(() => {
    if (!dfmReport) return [] as { x: number; y: number }[]
    const out: { x: number; y: number }[] = []
    for (const f of dfmReport.findings) {
      if (f.severity !== 'error' && f.severity !== 'warning') continue
      for (const loc of f.locations ?? []) out.push({ x: loc.x, y: loc.y })
    }
    return out
  }, [dfmReport])

  // Panel overlay — only shown on the Panel Config tab
  const panelOverlayContent = useMemo(() => {
    if (!panelResult || !isPanelViewTab(activeTab)) return null

    const pr = panelResult
    const pc = panelConfig

    // Determine if tooling holes should be shown (only when copper/mask/silk layers are visible)
    // If only outline layer is visible, don't show tooling holes
    const hasCopperOrMaskOrSilkLayers = visibleLayerTypes.has('copper') || visibleLayerTypes.has('mask') || visibleLayerTypes.has('silk')
    const showToolingHoles = pc.enableToolingHoles && hasCopperOrMaskOrSilkLayers

    const elements: React.ReactNode[] = []

    const isMirrored = viewMode === 'board' && boardViewSide === 'bottom'

    // Per-PCB outline preview: draw the real traced contour instead of the
    // rectangle when a contour-mode routing plan exists. `boardContour` is
    // only populated by generateRouting() (a Routing-tab action, and only
    // when outline mode resolves to 'contour'), so before that's ever run —
    // or on a plain-rectangle board where 'auto'/'bbox' correctly stays a
    // rectangle — this falls back to the same dashed rect as before.
    const contourOuter =
      routingResult?.pcbOutlineMode === 'contour' && boardContour && !boardContour.failureReason
        ? boardContour.rings.find(r => r.depth === 0 && !r.isHole)
        : null
    // Same translation datum convention as the exporter and planContourPcb:
    // the outline layer's own (arc-blind) bounds, not boardContour.boundsMm.
    const outlineDatum = contourOuter
      ? layers.find(l => l.type === 'outline' && l.visible && l.parsedLayer?.bounds)?.parsedLayer.bounds
      : null

    // PCB positions (Y-inverted to match Gerber SVG coordinate system)
    for (const pos of pr.pcbPositions) {
      const screenY = -pos.y
      const screenYBottom = -(pos.y + pr.pcbHeight)
      const tx = pos.x + pr.pcbWidth / 2
      const textY = (screenY + screenYBottom) / 2

      if (contourOuter && outlineDatum) {
        const dx = pos.x - outlineDatum.minX
        const dy = pos.y - outlineDatum.minY
        const pointsAttr = contourOuter.points
          .map(p => `${(p.x + dx).toFixed(4)},${(-(p.y + dy)).toFixed(4)}`)
          .join(' ')
        elements.push(
          <polygon key={`pcb-${pos.row}-${pos.col}`}
            points={pointsAttr}
            fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={0.1}
            strokeDasharray="1 1" vectorEffect="non-scaling-stroke" />
        )
      } else {
        elements.push(
          <rect key={`pcb-${pos.row}-${pos.col}`}
            x={pos.x} y={screenYBottom} width={pr.pcbWidth} height={pr.pcbHeight}
            fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={0.1}
            strokeDasharray="1 1" vectorEffect="non-scaling-stroke" />
        )
      }

      const labelText = (
        <text key={`pcb-label-${pos.row}-${pos.col}`}
          x={tx} y={textY}
          fill="rgba(255,255,255,0.5)" fontSize="2"
          textAnchor="middle" dominantBaseline="central"
          fontFamily="monospace" vectorEffect="non-scaling-stroke">
          {`${pos.row + 1},${pos.col + 1}`}
        </text>
      )

      elements.push(
        isMirrored ? (
          <g key={`pcb-label-g-${pos.row}-${pos.col}`} transform={`translate(${tx}, 0) scale(-1, 1) translate(${-tx}, 0)`}>
            {labelText}
          </g>
        ) : labelText
      )
    }

    // Panel outline (Y-inverted)
    elements.push(
      <rect key="panel-outline"
        x={0} y={-pr.panelHeight} width={pr.panelWidth} height={pr.panelHeight}
        fill="none" stroke="rgba(255,255,0,0.5)" strokeWidth={0.15}
        vectorEffect="non-scaling-stroke" />
    )

    // Tooling holes (Y-inverted)
    if (showToolingHoles) {
      for (const hole of pr.toolingHoles) {
        const color = hole.type === 'tooling' ? 'rgba(0,200,255,0.7)' : 'rgba(200,200,0,0.5)'
        const fill = hole.type === 'tooling' ? 'rgba(0,200,255,0.2)' : 'rgba(200,200,0,0.1)'
        elements.push(
          <circle key={`hole-${hole.x}-${hole.y}`}
            cx={hole.x} cy={-hole.y} r={hole.diameter / 2}
            fill={fill} stroke={color} strokeWidth={0.08}
            vectorEffect="non-scaling-stroke" />
        )
      }

      // Donut / annular rings around reference holes
      const refHoles = pr.toolingHoles.filter(h => h.type === 'reference')
      if (refHoles.length > 0) {
        const od = pc.donutOuterDiameter || 2.25
        const id = pc.donutInnerDiameter || 1.25
        for (const ref of refHoles) {
          elements.push(
            <circle key={`donut-outer-${ref.x}-${ref.y}`}
              cx={ref.x} cy={-ref.y} r={od / 2}
              fill="none" stroke="rgba(255,165,0,0.6)" strokeWidth={0.08}
              vectorEffect="non-scaling-stroke" />,
            <circle key={`donut-inner-${ref.x}-${ref.y}`}
              cx={ref.x} cy={-ref.y} r={id / 2}
              fill="none" stroke="rgba(255,165,0,0.6)" strokeWidth={0.08}
              vectorEffect="non-scaling-stroke" />
          )
        }
      }
    }

    // Determine which side's fiducials should be rendered in the overlay
    let showTopFids = false
    let showBottomFids = false

    if (pc.enableFiducials) {
      if (isBoardMode) {
        if (boardViewSide === 'top' && pc.fiducialsTop) showTopFids = true
        if (boardViewSide === 'bottom' && pc.fiducialsBottom) showBottomFids = true
      } else {
        // Layers mode: check the side of the visible copper or mask layers
        for (const layer of visibleLayers) {
          if (layer.type === 'copper' || layer.type === 'mask') {
            if (layer.side === 'top' && pc.fiducialsTop) showTopFids = true
            if (layer.side === 'bottom' && pc.fiducialsBottom) showBottomFids = true
          }
        }
      }
    }

    // Fiducials (Y-inverted)
    if (showTopFids || showBottomFids) {
      for (const fid of pr.fiducials) {
        elements.push(
          <circle key={`fid-clr-${fid.x}-${fid.y}`}
            cx={fid.x} cy={-fid.y} r={fid.clearance / 2}
            fill="none" stroke="rgba(0,255,100,0.4)" strokeWidth={0.08}
            vectorEffect="non-scaling-stroke" />,
          <circle key={`fid-dot-${fid.x}-${fid.y}`}
            cx={fid.x} cy={-fid.y} r={fid.diameter / 2}
            fill="rgba(0,255,100,0.8)" stroke="none" />
        )
      }
    }

    // L-shape corner marks (Y-inverted) — preview of what generatePanelizedGerber
    // actually adds to copper/mask on export. Gated the same way the exporter
    // gates it (rectangular-outline check + enableLShapeMarks + arm fits the
    // PCB) so the preview never shows marks that export would silently drop.
    if (pc.enableLShapeMarks && (visibleLayerTypes.has('copper') || visibleLayerTypes.has('mask'))) {
      const outlineLayer = layers.find(l => l.type === 'outline' && l.parsedLayer?.bounds)
      const outlineOk = outlineLayer ? isRectangularOutline(outlineLayer.parsedLayer) : false
      const arm = pc.lShapeArmLength
      const w = pr.pcbWidth
      const h = pr.pcbHeight
      const maxArm = Math.min(w / 2, h / 2)
      if (outlineOk && arm > 0 && arm <= maxArm) {
        for (const pos of pr.pcbPositions) {
          const sy = (ly: number) => -(pos.y + ly)
          const gx = (lx: number) => pos.x + lx
          const corners = [
            `M${gx(arm)} ${sy(0)}L${gx(0)} ${sy(0)}L${gx(0)} ${sy(arm)}`,             // bottom-left
            `M${gx(w - arm)} ${sy(0)}L${gx(w)} ${sy(0)}L${gx(w)} ${sy(arm)}`,          // bottom-right
            `M${gx(w)} ${sy(h - arm)}L${gx(w)} ${sy(h)}L${gx(w - arm)} ${sy(h)}`,      // top-right
            `M${gx(arm)} ${sy(h)}L${gx(0)} ${sy(h)}L${gx(0)} ${sy(h - arm)}`,          // top-left
          ]
          for (const [ci, d] of corners.entries()) {
            elements.push(
              <path key={`lshape-${pos.row}-${pos.col}-${ci}`}
                d={d} fill="none" stroke="rgba(255,20,147,0.85)" strokeWidth={0.15}
                vectorEffect="non-scaling-stroke" />
            )
          }
        }
      }
    }

    // Info text — render on side ribs.
    // Region-font mode: draw the TRUE glyph polygons so the preview is WYSIWYG
    // with the exported Gerber. getRegionTextPolygons returns world-space
    // (Gerber Y-up, mm) outer + counter contours with alignment/rotation/mirror
    // already baked in — negate Y (screenY = -gerberY) and use fill-rule
    // evenodd so counters cut out. Stroke-font mode keeps the native <text>.
    const useRegionGlyphs = panelConfig.textFont === 'region'
    for (const [idx, info] of pr.infoTexts.entries()) {
      if (useRegionGlyphs) {
        if (!info.text) continue
        const { outer, inner } = getRegionTextPolygons(info)
        if (outer.length === 0 && inner.length === 0) continue
        const toSub = (poly: { x: number; y: number }[]) =>
          poly.length ? `M${poly.map(p => `${p.x.toFixed(4)} ${(-p.y).toFixed(4)}`).join('L')}Z` : ''
        const d = [...outer, ...inner].map(toSub).join('')
        const fill = info.mirrored
          ? 'rgba(0,200,255,0.6)'        // dimmer cyan for mirrored (bottom) text
          : info.location === 'left-rib' || info.location === 'right-rib'
            ? 'rgba(0,200,255,0.85)'     // cyan for vertical rib text
            : 'rgba(210,210,210,0.85)'   // light gray for horizontal rib text
        elements.push(
          <path key={`info-${idx}-${info.x}-${info.y}`}
            d={d} fill={fill} fillRule="evenodd" stroke="none" />
        )
        continue
      }

      // --- stroke-font mode: native <text> approximation ---
      const screenInfoY = -info.y
      const rot = -(info.rotation || 0) // Negate rotation for Y-inverted space
      const baseTransform = rot !== 0 ? `rotate(${rot}, ${info.x}, ${screenInfoY})` : undefined

      // Approximate text width for alignment (stroke font uses fixed advance)
      const CHAR_WIDTH_FONT = 0.6
      const ADVANCE_WIDTH_FONT = 0.7
      const textWidth = info.text
        ? ((info.text.length - 1) * ADVANCE_WIDTH_FONT + CHAR_WIDTH_FONT) * info.fontSize
        : 0

      const textContent = (
        <text
          x={info.x} y={screenInfoY}
          textLength={textWidth > 0 ? textWidth : undefined}
          lengthAdjust="spacingAndGlyphs"
          fill={info.mirrored
            ? 'rgba(0,200,255,0.5)'      // dimmer cyan for mirrored (bottom) layer text
            : info.location === 'left-rib' || info.location === 'right-rib'
              ? 'rgba(0,200,255,0.8)'     // cyan for vertical rib text
              : 'rgba(200,200,200,0.7)'}  // gray for horizontal rib text
          fontSize={info.fontSize}
          textAnchor={info.align === 'center' ? 'middle' : info.align === 'right' ? 'end' : 'start'}
          fontFamily="monospace"
          dominantBaseline="central"
          transform={baseTransform}
          vectorEffect="non-scaling-stroke">
          {info.text}
        </text>
      )

      // For mirrored text (bottom layers), wrap in a group that flips horizontally
      // around the text's x position so it reads correctly from the PCB bottom side
      if (info.mirrored) {
        elements.push(
          <g key={`info-${idx}-${info.x}-${info.y}`}
            transform={`translate(${info.x}, 0) scale(-1, 1) translate(${-info.x}, 0)`}>
            {textContent}
          </g>
        )
      } else {
        elements.push(
          <g key={`info-${idx}-${info.x}-${info.y}`}>
            {textContent}
          </g>
        )
      }
    }

    // Panel dimensions (Y-inverted)
    const dimWText = (
      <text key="dim-w"
        x={pr.panelWidth / 2} y={2}
        fill="rgba(255,200,0,0.9)" fontSize="1.8"
        textAnchor="middle" fontFamily="monospace"
        vectorEffect="non-scaling-stroke">
        {`${pr.panelWidth.toFixed(1)} mm`}
      </text>
    )

    const dimHText = (
      <text key="dim-h"
        x={-2} y={-pr.panelHeight / 2}
        fill="rgba(255,200,0,0.9)" fontSize="1.8"
        textAnchor="middle" fontFamily="monospace"
        transform={`rotate(-90, ${-2}, ${-pr.panelHeight / 2})`}
        vectorEffect="non-scaling-stroke">
        {`${pr.panelHeight.toFixed(1)} mm`}
      </text>
    )

    elements.push(
      isMirrored ? (
        <g key="dim-w-g" transform={`translate(${pr.panelWidth / 2}, 0) scale(-1, 1) translate(${-pr.panelWidth / 2}, 0)`}>
          {dimWText}
        </g>
      ) : dimWText,
      isMirrored ? (
        <g key="dim-h-g" transform={`translate(${-2}, 0) scale(-1, 1) translate(${2}, 0)`}>
          {dimHText}
        </g>
      ) : dimHText
    )

    return elements
  }, [panelResult, panelConfig, activeTab, visibleLayerTypes, layers, routingResult, boardContour])

  // Route overlay — router tool paths, tabs and mouse bites.
  //
  // Deliberately separate from panelOverlayContent: it is gated on
  // routingResult (an explicit user action) rather than on panelResult + tab, so
  // a generated plan stays visible while you look at other tabs.
  //
  // Y is negated throughout (screenY = −gerberY); the planner works in Gerber
  // Y-up mm and this viewer's space is Y-down.
  const routeOverlayContent = useMemo(() => {
    if (!routingResult || routingResult.paths.length === 0) return null

    const elements: React.ReactNode[] = []
    const bit = routingResult.config.bitDiameterMm

    // Build each path's `d` string ONCE, then draw it twice below (swath
    // underlay + centerline overlay) — this used to recompute the identical
    // .map().join() separately in each of the two loops, doubling the work
    // for no reason (harmless at bbox-mode path counts, but contour mode's
    // much larger point counts per path make it worth not doing twice).
    // Still two SEPARATE render loops, not merged into one: SVG paints in
    // document order, and pushing "ALL swaths, then ALL centerlines" (rather
    // than interleaving swath/centerline per path) is what guarantees every
    // centerline draws on top of every swath, including a NEIGHBOURING
    // path's — merging the loops would let one path's wide translucent swath
    // paint over an earlier path's thin centerline wherever they overlap.
    const pathDs = routingResult.paths
      .filter(path => path.points.length >= 2)
      .map(path => ({
        path,
        d: path.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(4)} ${(-p.y).toFixed(4)}`).join(''),
      }))

    // The cut swath, drawn at the REAL bit width. Note the deliberate absence
    // of vectorEffect="non-scaling-stroke" here — unlike almost everything in
    // panelOverlayContent, this stroke must scale with zoom, because its width
    // *is* the physical material the cutter removes. A non-scaling stroke
    // would make the preview lie about how much copper the router eats.
    for (const { path, d } of pathDs) {
      elements.push(
        <path key={`swath-${path.id}`}
          d={d} fill="none" stroke="rgba(255,120,0,0.28)" strokeWidth={bit}
          strokeLinecap="round" strokeLinejoin="round" />
      )
    }

    // Tool-center centerlines on top, thin and zoom-independent so the actual
    // programmed path stays legible at any magnification.
    for (const { path, d } of pathDs) {
      elements.push(
        <path key={`center-${path.id}`}
          d={d} fill="none" stroke="rgba(255,160,60,0.95)" strokeWidth={0.12}
          strokeDasharray="0.8 0.4" vectorEffect="non-scaling-stroke" />
      )
    }

    // Tabs: the uncut material bridge, drawn along the board edge.
    for (const tab of routingResult.tabs) {
      const half = tab.widthMm / 2
      const x1 = tab.center.x - tab.dir.x * half
      const y1 = tab.center.y - tab.dir.y * half
      const x2 = tab.center.x + tab.dir.x * half
      const y2 = tab.center.y + tab.dir.y * half
      elements.push(
        <line key={`tab-${tab.id}`}
          x1={x1} y1={-y1} x2={x2} y2={-y2}
          stroke="rgba(80,255,140,0.9)" strokeWidth={0.35}
          strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      )
      for (const [hi, h] of tab.holes.entries()) {
        elements.push(
          <circle key={`bite-${tab.id}-${hi}`}
            cx={h.x} cy={-h.y} r={tab.holeDiameterMm / 2}
            fill="rgba(10,20,35,0.85)" stroke="rgba(80,255,140,0.9)" strokeWidth={0.05}
            vectorEffect="non-scaling-stroke" />
        )
      }
    }

    return elements
  }, [routingResult])

  // Crosshair
  const crosshairContent = useMemo(() => {
    if (!showCrosshair || !cursorPos) return null
    const vb = parseViewBox(viewState.viewBox)
    if (!vb) return null

    const visMinX = vb.x
    const visMaxX = vb.x + vb.w
    const visMinY = vb.y
    const visMaxY = vb.y + vb.h

    return (
      <>
        <line x1={cursorPos.gx} y1={visMinY} x2={cursorPos.gx} y2={visMaxY}
          stroke="rgba(255,255,255,0.3)" strokeWidth={0.03} strokeDasharray="0.5 0.5" />
        <line x1={visMinX} y1={cursorPos.gy} x2={visMaxX} y2={cursorPos.gy}
          stroke="rgba(255,255,255,0.3)" strokeWidth={0.03} strokeDasharray="0.5 0.5" />
      </>
    )
  }, [showCrosshair, cursorPos, viewState, parseViewBox])

  const formatCoord = (val: number) => {
    if (isNaN(val)) return '—'
    return targetUnit === 'mm' ? val.toFixed(3) : (val / 25.4).toFixed(4)
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[400px] bg-[#020d1f] rounded-lg overflow-hidden border border-[#1a3a5c]">
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full cursor-crosshair"
        style={{ height: `calc(100% - 28px)` }}
        viewBox={viewState.viewBox}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Grid layer */}
        {gridContent && <g data-layer="grid">{gridContent}</g>}

        {/* Gerber content — board view (composited stack-up) when available,
            per-layer overlay otherwise. */}
        <g 
          data-layer="gerber-content"
          transform={viewMode === 'board' && boardViewSide === 'bottom' && combinedBounds
            ? `translate(${boundsCenterX}, 0) scale(-1, 1) translate(${-boundsCenterX}, 0)`
            : undefined}
        >
          {isBoardMode ? (() => {
            // Board view: per-layer compositing with PCB-realistic colors.
            // Uses the existing per-layer SVG data (already working) instead of
            // tracespace/core renderBoard which had compositing issues.
            const bLayers = boardModeLayers
            const bounds = nativeSvgBounds

            if (bLayers.length === 0) {
              return (
                <text x="0" y="0" fill="#888" fontSize="3" textAnchor="middle"
                  transform={viewMode === 'board' && boardViewSide === 'bottom' ? 'scale(-1, 1)' : undefined}>
                  No layers for {boardViewSide} side
                </text>
              )
            }

            // Dark FR4 substrate background. When the board outline traced
            // into a closed shape (boardView.shapePathD), clip the substrate
            // to it so non-rectangular boards (chamfers/cutouts) don't show a
            // rectangle overlapping the PCB border.
            const rawBgRect = bounds ? (
              <rect
                key="pcb-bg"
                x={bounds.minX - 0.2} y={bounds.minY - 0.2}
                width={bounds.maxX - bounds.minX + 0.4}
                height={bounds.maxY - bounds.minY + 0.4}
                fill={BOARD_COLOR_PALETTE[boardColor].substrate}
              />
            ) : null
            const outlineShape = boardView?.shapePathD ?? null
            const bgRect = rawBgRect && outlineShape ? (
              <g key="pcb-bg-clipped">
                <defs>
                  <clipPath id="board-outline-clip">
                    <path
                      d={outlineShape}
                      transform={boardView!.shapeScale !== 1 ? `scale(${boardView!.shapeScale})` : undefined}
                    />
                  </clipPath>
                </defs>
                <g clipPath="url(#board-outline-clip)">{rawBgRect}</g>
              </g>
            ) : rawBgRect

            if (isPanelViewTab(activeTab) && panelResult && nativeSvgBounds) {
              const pr = panelResult
              const refBounds = nativeSvgBounds
              const maskClipPairs = getMaskClipPairs(bLayers)
              const maskClipByMaskId = new Map(maskClipPairs.map(p => [p.maskLayerId, p]))
              return (
                <>
                  <defs>
                    {bLayers.map(layer => (
                      layer.svgData ? (
                        <RawSvgSymbol
                          key={`def-${layer.id}`}
                          id={`layer-def-${layer.id}`}
                          html={layer.svgData.svgFragment}
                        />
                      ) : null
                    ))}
                    {maskClipPairs.map(pair => (
                      // colorInterpolation: 'sRGB' avoids the linearRGB luminance-mask
                      // dark-edge halo — see RawSvgMask in raw-svg-group.tsx for why.
                      <mask key={`mask-mask-${pair.maskLayerId}`} id={`mask-mask-${pair.maskLayerId}`} style={{ colorInterpolation: 'sRGB' }}>
                        <use href={`#layer-def-${pair.maskLayerId}`} style={{ color: '#fff' }} />
                      </mask>
                    ))}
                    {pr.pcbPositions.map((pos, idx) => (
                      <clipPath key={`pcb-clip-${idx}`} id={`pcb-clip-${idx}`}>
                        <rect
                          x={pos.x}
                          y={-(pos.y + pr.pcbHeight)}
                          width={pr.pcbWidth}
                          height={pr.pcbHeight}
                        />
                      </clipPath>
                    ))}
                  </defs>
                  {pr.pcbPositions.map((pos, posIdx) => {
                    const tx = pos.x - refBounds.minX
                    const ty = -pos.y - refBounds.maxY
                    return (
                      <g key={`panel-pos-${posIdx}`} clipPath={`url(#pcb-clip-${posIdx})`}>
                        <g transform={`translate(${tx.toFixed(6)}, ${ty.toFixed(6)})`}>
                          {bgRect}
                          {bLayers.map(layer => {
                            const clipPair = maskClipByMaskId.get(layer.id)
                            if (clipPair) {
                              return (
                                <React.Fragment key={layer.id}>
                                  {/* Exposed bare FR4 under the mask opening —
                                      see the single-PCB board view below for
                                      why this is needed. */}
                                  {bounds && (
                                    <rect
                                      x={bounds.minX} y={bounds.minY}
                                      width={bounds.maxX - bounds.minX} height={bounds.maxY - bounds.minY}
                                      mask={`url(#mask-mask-${layer.id})`}
                                      fill={EXPOSED_SUBSTRATE_COLOR}
                                    />
                                  )}
                                  <use
                                    href={`#layer-def-${clipPair.copperLayerId}`}
                                    data-layer={layer.id}
                                    mask={`url(#mask-mask-${layer.id})`}
                                    style={{ color: getBoardLayerColor('mask', layer.side), opacity: PCB_OPACITY.copper ?? 1 }}
                                  />
                                </React.Fragment>
                              )
                            }
                            return (
                              <use
                                key={layer.id}
                                href={`#layer-def-${layer.id}`}
                                data-layer={layer.id}
                                style={{ color: getBoardLayerColor(layer.type, layer.side), opacity: PCB_OPACITY[layer.type] ?? 1 }}
                              />
                            )
                          })}
                        </g>
                      </g>
                    )
                  })}
                </>
              )
            }

            // Single-PCB board view
            const maskClipPairs = getMaskClipPairs(bLayers)
            const bLayerById = new Map(bLayers.map(l => [l.id, l]))
            return (
              <>
                {bgRect}
                {bLayers.map(layer => {
                  const clipPair = maskClipPairs.find(p => p.maskLayerId === layer.id)
                  if (clipPair) {
                    const copperLayer = bLayerById.get(clipPair.copperLayerId)
                    if (!copperLayer?.svgData) return null
                    const maskId = `board-mask-mask-${layer.id}`
                    return (
                      <React.Fragment key={layer.id}>
                        <RawSvgMask id={maskId} html={layer.svgData!.svgFragment} />
                        {/* Exposed bare FR4, painted first and clipped to the
                            mask opening — shows through wherever the opening
                            has NO copper to reveal (the gold copy below
                            paints over it opaque wherever copper does exist).
                            Without this, a mask-only opening (e.g. a keepout
                            relief with no copper pour beneath it) is fully
                            invisible: the gold-reveal technique below only
                            ever shows copper *through* the mask, never the
                            mask's own real geometry. */}
                        {bounds && (
                          <g mask={`url(#${maskId})`}>
                            <rect
                              x={bounds.minX} y={bounds.minY}
                              width={bounds.maxX - bounds.minX} height={bounds.maxY - bounds.minY}
                              fill={EXPOSED_SUBSTRATE_COLOR}
                            />
                          </g>
                        )}
                        <g mask={`url(#${maskId})`}>
                          <RawSvgGroup
                            data-layer={layer.id}
                            style={{ color: getBoardLayerColor('mask', layer.side), opacity: PCB_OPACITY.copper ?? 1 }}
                            html={copperLayer.svgData.svgFragment}
                          />
                        </g>
                      </React.Fragment>
                    )
                  }
                  return (
                    <RawSvgGroup
                      key={layer.id}
                      data-layer={layer.id}
                      style={{ color: getBoardLayerColor(layer.type, layer.side), opacity: PCB_OPACITY[layer.type] ?? 1 }}
                      html={layer.svgData!.svgFragment}
                    />
                  )
                })}
              </>
            )
          })() : isPanelViewTab(activeTab) && panelResult && nativeSvgBounds ? (() => {
            // Per-layer overlay — fallback when board view is unavailable.
            const outlineLayer = visibleLayers.find(l => l.type === 'outline' && l.svgData?.boundsObj)
            const refBounds = (outlineLayer?.svgData?.boundsObj) || nativeSvgBounds
            const pr = panelResult

            return (
              <>
                <defs>
                  {visibleLayers.map(layer => (
                    layer.svgData ? (
                      <RawSvgSymbol
                        key={`def-${layer.id}`}
                        id={`layer-def-${layer.id}`}
                        html={layer.svgData.svgFragment}
                      />
                    ) : null
                  ))}
                  {pr.pcbPositions.map((pos, idx) => (
                    <clipPath key={`pcb-clip-${idx}`} id={`pcb-clip-${idx}`}>
                      <rect
                        x={pos.x}
                        y={-(pos.y + pr.pcbHeight)}
                        width={pr.pcbWidth}
                        height={pr.pcbHeight}
                      />
                    </clipPath>
                  ))}
                </defs>

                {pr.pcbPositions.map((pos, posIdx) => {
                  const tx = pos.x - refBounds.minX
                  const ty = -pos.y - refBounds.maxY
                  return (
                    <g key={`panel-pos-${posIdx}`} clipPath={`url(#pcb-clip-${posIdx})`}>
                      <g transform={`translate(${tx.toFixed(6)}, ${ty.toFixed(6)})`}>
                        {visibleLayers.map(layer => {
                          if (!layer.svgData) return null
                          return (
                            <use
                              key={layer.id}
                              href={`#layer-def-${layer.id}`}
                              data-layer={layer.id}
                              style={{ color: layer.color, opacity: layer.opacity }}
                            />
                          )
                        })}
                      </g>
                    </g>
                  )
                })}
              </>
            )
          })() : (
            visibleLayers.map(layer => {
              if (!layer.svgData) return null
              return (
                <RawSvgGroup
                  key={layer.id}
                  data-layer={layer.id}
                  style={{ color: layer.color, opacity: layer.opacity }}
                  html={layer.svgData.svgFragment}
                />
              )
            })
          )}
        </g>

        {/* Panel overlay — only on panel tab */}
        {panelOverlayContent && (
          <g 
            data-layer="panel-overlay"
            transform={viewMode === 'board' && boardViewSide === 'bottom' && combinedBounds
              ? `translate(${boundsCenterX}, 0) scale(-1, 1) translate(${-boundsCenterX}, 0)`
              : undefined}
          >
            {panelOverlayContent}
          </g>
        )}

        {/* Route overlay — router tool paths, tabs, mouse bites. Carries the
            SAME bottom-side mirror as the panel overlay above: a route is a
            physical cut, so it must not disagree with the panel it cuts when
            viewed from the bottom.

            ANIMATION SEAM: the deferred CNC tooling animation belongs inside
            this group — it needs only routingResult.paths plus a cumulative
            per-segment length table to interpolate a moving cutter marker.
            Nothing else here has to change for it. */}
        {routeOverlayContent && (
          <g
            data-layer="route-overlay"
            transform={viewMode === 'board' && boardViewSide === 'bottom' && combinedBounds
              ? `translate(${boundsCenterX}, 0) scale(-1, 1) translate(${-boundsCenterX}, 0)`
              : undefined}
          >
            {routeOverlayContent}
          </g>
        )}

        {/* DFM finding markers. Locations arrive in Gerber-native Y-up mm, so
            Y is negated into this viewer's Y-down space. The bottom-side mirror
            is applied here too, matching the panel overlay above — without it a
            marker would sit on the mirror image of the offending geometry. */}
        {dfmMarkers.length > 0 && (
          <g
            data-layer="dfm-markers"
            transform={viewMode === 'board' && boardViewSide === 'bottom' && combinedBounds
              ? `translate(${boundsCenterX}, 0) scale(-1, 1) translate(${-boundsCenterX}, 0)`
              : undefined}
          >
            {dfmMarkers.map((m, i) => {
              // Keep the marker a constant on-screen size regardless of zoom.
              const r = 12 / Math.max(viewState.zoom, 0.0001)
              const stroke = Math.max(r * 0.12, 0.02)
              const isFocused =
                !!dfmFocus && Math.abs(dfmFocus.x - m.x) < 1e-6 && Math.abs(dfmFocus.y - m.y) < 1e-6
              return (
                <g key={`${m.x},${m.y},${i}`} transform={`translate(${m.x}, ${-m.y})`}>
                  <circle
                    r={r}
                    fill="none"
                    stroke={isFocused ? '#f87171' : '#fbbf24'}
                    strokeWidth={stroke}
                    opacity={0.95}
                  />
                  <line x1={-r * 1.5} y1={0} x2={-r * 0.4} y2={0} stroke={isFocused ? '#f87171' : '#fbbf24'} strokeWidth={stroke} />
                  <line x1={r * 0.4} y1={0} x2={r * 1.5} y2={0} stroke={isFocused ? '#f87171' : '#fbbf24'} strokeWidth={stroke} />
                  <line x1={0} y1={-r * 1.5} x2={0} y2={-r * 0.4} stroke={isFocused ? '#f87171' : '#fbbf24'} strokeWidth={stroke} />
                  <line x1={0} y1={r * 0.4} x2={0} y2={r * 1.5} stroke={isFocused ? '#f87171' : '#fbbf24'} strokeWidth={stroke} />
                </g>
              )
            })}
          </g>
        )}

        {/* Crosshair */}
        {crosshairContent && <g data-layer="crosshair">{crosshairContent}</g>}
      </svg>

      {/* Status bar */}
      <div className="absolute bottom-0 left-0 right-0 h-7 bg-[#020d1f]/90 text-xs text-[#94b8d4] flex items-center px-2 gap-4 font-mono rounded-b-lg border-t border-[#1a3a5c]">
        <span className="text-[#4a6f94]">
          {layers.length === 0 ? 'Import Gerber files to start' : `${visibleLayers.length}/${layers.length} layers`}
        </span>
        {cursorPos && (
          <span>
            X: {formatCoord(cursorPos.gx)} Y: {formatCoord(cursorPos.gy)} {targetUnit}
          </span>
        )}
        <span>Zoom: {viewState.zoom.toFixed(1)}x</span>
        {isPanelViewTab(activeTab) && panelResult && (
          <span className="text-[#0ea5e9]">
            Panel: {panelResult.panelWidth.toFixed(1)}×{panelResult.panelHeight.toFixed(1)} mm | {panelResult.totalPCBs} PCBs
          </span>
        )}
        <span className="ml-auto text-[#2a4a6a]">
          Scroll=Zoom Alt+Drag=Pan DblClick=Fit
        </span>
      </div>

      {/* View-mode + side toggle (only when layers exist) */}
      {layers.length > 0 && (() => {
        const topHasCopperOrSilk = layers.some(l => (l.type === 'copper' || l.type === 'silk') && l.side === 'top')
        const botHasCopperOrSilk = layers.some(l => (l.type === 'copper' || l.type === 'silk') && l.side === 'bottom')
        const currentSideEmpty = viewMode === 'board' && (
          (boardViewSide === 'top' && !topHasCopperOrSilk) ||
          (boardViewSide === 'bottom' && !botHasCopperOrSilk)
        )
        return (
          <>
            <div className="absolute top-2 left-2 flex gap-1 bg-[#020d1f]/85 rounded border border-[#1a3a5c] p-0.5 text-xs font-medium">
              <button
                onClick={() => setViewMode('board')}
                className={`px-2 py-1 rounded transition-colors ${viewMode === 'board' ? 'bg-[#0ea5e9] text-white' : 'text-[#94b8d4] hover:bg-[#0f2848]/50'}`}
                title="Composited PCB stack-up view"
              >Board</button>
              <button
                onClick={() => setViewMode('layers')}
                className={`px-2 py-1 rounded transition-colors ${viewMode === 'layers' ? 'bg-[#0ea5e9] text-white' : 'text-[#94b8d4] hover:bg-[#0f2848]/50'}`}
                title="Individual layers overlay"
              >Layers</button>
              {viewMode === 'board' && (
                <>
                  <span className="w-px bg-[#1a3a5c] mx-0.5" />
                  <button
                    onClick={() => setBoardViewSide('top')}
                    className={`px-2 py-1 rounded transition-colors ${boardViewSide === 'top' ? 'bg-[#38bdf8] text-white' : 'text-[#94b8d4] hover:bg-[#0f2848]/50'}`}
                    title={topHasCopperOrSilk ? 'Top side' : 'Top side (no copper/silk layers)'}
                  >Top{!topHasCopperOrSilk && <span className="ml-0.5 opacity-50">∅</span>}</button>
                  <button
                    onClick={() => setBoardViewSide('bottom')}
                    className={`px-2 py-1 rounded transition-colors ${boardViewSide === 'bottom' ? 'bg-[#38bdf8] text-white' : 'text-[#94b8d4] hover:bg-[#0f2848]/50'}`}
                    title={botHasCopperOrSilk ? 'Bottom side' : 'Bottom side (no copper/silk layers)'}
                  >Bottom{!botHasCopperOrSilk && <span className="ml-0.5 opacity-50">∅</span>}</button>
                  {/* Soldermask color swatches — Board view only (cosmetic preview, no effect on export) */}
                  <span className="w-px bg-[#1a3a5c] mx-0.5" />
                  <div className="flex items-center gap-1 px-0.5">
                    {BOARD_COLOR_NAMES.map(name => (
                      <button
                        key={name}
                        onClick={() => setBoardColor(name)}
                        title={`${name} soldermask`}
                        className={`w-4 h-4 rounded-full border transition-all ${
                          boardColor === name ? 'border-white scale-110' : 'border-[#1a3a5c] hover:border-[#4a6f94]'
                        }`}
                        style={{ backgroundColor: BOARD_COLOR_PALETTE[name].swatch }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
            {/* Warn when viewing a side with no copper data */}
            {isBoardMode && currentSideEmpty && (
              <div className="absolute top-10 left-1/2 -translate-x-1/2 bg-[#1a1a00]/90 border border-yellow-500/50 text-yellow-300 text-xs px-3 py-1.5 rounded-lg pointer-events-none">
                No {boardViewSide} copper/silk layers imported — switch to {boardViewSide === 'top' ? 'Bottom' : 'Top'} view
              </div>
            )}
          </>
        )
      })()}


      {/* Zoom controls */}
      <div className="absolute top-2 right-2 flex flex-col gap-1">
        <button
          onClick={() => doZoom(0.75)}
          className="w-7 h-7 bg-[#0a1e38]/75 hover:bg-[#0f2848] text-[#f0f8ff] rounded flex items-center justify-center text-sm border border-[#1a3a5c] transition-colors"
        >+</button>
        <button
          onClick={() => doZoom(1.33)}
          className="w-7 h-7 bg-[#0a1e38]/75 hover:bg-[#0f2848] text-[#f0f8ff] rounded flex items-center justify-center text-sm border border-[#1a3a5c] transition-colors"
        >−</button>
        <button
          onClick={fitToView}
          className="w-7 h-7 bg-[#0a1e38]/75 hover:bg-[#0f2848] text-[#f0f8ff] rounded flex items-center justify-center text-sm border border-[#1a3a5c] transition-colors"
          title="Fit to view"
        >⊞</button>
      </div>
    </div>
  )
}
