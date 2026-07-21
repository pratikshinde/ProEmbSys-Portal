'use client'

/**
 * Read-only composited board preview for the PCB Order page. Renders an
 * already-uploaded Gerber set (raw file entries — no ZIP/RAR handling here,
 * the caller extracts) in the soldermask color the customer is ordering.
 *
 * Deliberately store-independent (doesn't touch the Panelization tool's
 * Zustand store — see gerber-viewer.tsx) so the marketing/order shell never
 * pulls in CAM-tool state. Shares its color/opacity/z-order tables with
 * gerber-viewer.tsx via board-colors.ts so the two renders never drift.
 */

import React, { useEffect, useRef, useState } from 'react'
import { gerberToSvg, gerberRenderBoardView, mergeLayerBounds, GerberSvgResult } from '@/lib/gerber-svg'
import { detectLayerType, detectLayerSide, LayerType, LayerSide } from '@/lib/gerber-analysis'
import { isExcellonDrillFile } from '@/lib/gerber-parser'
import { BOARD_COLOR_PALETTE, BoardColorName, getPcbColor, PCB_OPACITY, silkColorFor, getLayerZIndex, getMaskClipPairs } from '@/lib/board-colors'
import { RawSvgGroup, RawSvgMask } from './raw-svg-group'

export interface BoardPreviewEntry {
  name: string
  content: string
}

interface RenderedLayer {
  id: string
  type: LayerType
  side: LayerSide
  svgData: GerberSvgResult
}

interface ViewBox {
  x: number
  y: number
  width: number
  height: number
}

export default function BoardPreview({
  entries,
  maskColor,
  className,
}: {
  entries: BoardPreviewEntry[]
  maskColor: BoardColorName
  className?: string
}) {
  const [layers, setLayers] = useState<RenderedLayer[]>([])
  const [viewBox, setViewBox] = useState<ViewBox | null>(null)
  const [shapePathD, setShapePathD] = useState<string | null>(null)
  const [shapeScale, setShapeScale] = useState(1)
  const [side, setSide] = useState<'top' | 'bottom'>('top')
  const [loading, setLoading] = useState(entries.length > 0)
  const [error, setError] = useState<string | null>(null)
  // Bumped on every entries change so an in-flight render from a superseded
  // upload can't clobber state after a newer one has already resolved.
  const requestIdRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestIdRef.current

    if (entries.length === 0) {
      setLayers([])
      setViewBox(null)
      setShapePathD(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        // Render every entry first so we have each one's worker-parsed
        // TF.FileFunction hint (layerAnalysis) available for classification.
        const svgResults = await Promise.all(entries.map(e => gerberToSvg(e.content)))

        if (requestId !== requestIdRef.current) return // a newer upload superseded this one

        // Classify the same way the CAM tool's store does: content-sniffed
        // drill files first (most reliable), then the file's own
        // TF.FileFunction attribute (via gerberToSvg's layerAnalysis), then
        // filename heuristics (gerber-analysis.ts) as a last resort — needed
        // because plenty of real exports (e.g. "..._B_Mask.gbr") don't match
        // the filename heuristic's expected patterns even though the file
        // itself declares its function correctly.
        const classified = entries
          .map((entry, i) => {
            const base = entry.name.split('/').pop() || entry.name
            const svgData = svgResults[i]
            let type: LayerType
            let layerSide: LayerSide
            if (isExcellonDrillFile(entry.content)) {
              type = 'drill'
              layerSide = 'none'
            } else if (svgData.layerAnalysis?.type) {
              type = svgData.layerAnalysis.type as LayerType
              layerSide = svgData.layerAnalysis.side as LayerSide
            } else {
              type = detectLayerType(base)
              layerSide = detectLayerSide(base, type)
            }
            return { id: `${i}-${base}`, filename: base, content: entry.content, type, side: layerSide, svgData }
          })
          .filter(l => l.type !== 'fab' && l.type !== 'other')

        if (classified.length === 0) {
          setLayers([])
          setError('No recognizable Gerber layers to preview.')
          setLoading(false)
          return
        }

        const boardView = await gerberRenderBoardView(
          classified.map(l => ({ filename: l.filename, contents: l.content, type: l.type, side: l.side }))
        )

        if (requestId !== requestIdRef.current) return // a newer upload superseded this one

        const rendered: RenderedLayer[] = classified
          .filter(l => l.svgData.boundsObj && !l.svgData.isEmpty)

        if (rendered.length === 0) {
          setLayers([])
          setError('Could not render a preview from this Gerber set.')
          setLoading(false)
          return
        }

        // gerberRenderBoardView's viewBox already folds in a content-bounds
        // fallback when the traced outline isn't trustworthy — only fall
        // further back to our own per-layer union if it's still empty.
        let vb: ViewBox | null = boardView.viewBox
        if (!vb || vb.width <= 0 || vb.height <= 0) {
          const merged = mergeLayerBounds(rendered.map(l => l.svgData))
          vb = merged
            ? { x: merged.minX, y: merged.minY, width: merged.maxX - merged.minX, height: merged.maxY - merged.minY }
            : null
        }

        // Default to whichever side actually has copper/mask/silk content.
        const hasTop = rendered.some(l => (l.type === 'copper' || l.type === 'silk' || l.type === 'mask') && l.side === 'top')
        const hasBottom = rendered.some(l => (l.type === 'copper' || l.type === 'silk' || l.type === 'mask') && l.side === 'bottom')

        setLayers(rendered)
        setViewBox(vb)
        setShapePathD(boardView.shapePathD)
        setShapeScale(boardView.shapeScale ?? 1)
        setSide(!hasTop && hasBottom ? 'bottom' : 'top')
        setLoading(false)
      } catch (err) {
        if (requestId === requestIdRef.current) {
          setError(err instanceof Error ? err.message : 'Preview failed to render.')
          setLoading(false)
        }
      }
    })()
  }, [entries])

  const sideLayers = layers
    .filter(l => l.type === 'outline' || l.type === 'drill' || l.side === side || l.side === 'none')
    .slice()
    .sort((a, b) => getLayerZIndex(a.type) - getLayerZIndex(b.type))

  const hasBothSides = layers.some(l => l.side === 'top') && layers.some(l => l.side === 'bottom')
  const boundsCenterX = viewBox ? viewBox.x + viewBox.width / 2 : 0
  const palette = BOARD_COLOR_PALETTE[maskColor]
  const copperTint = palette.copperTint
  const silkColor = silkColorFor(maskColor)
  const maskClipPairs = getMaskClipPairs(sideLayers)
  const layerById = new Map(sideLayers.map(l => [l.id, l]))

  return (
    <div className={className}>
      {loading && (
        <div className="flex items-center justify-center h-48 text-[#94b8d4] text-xs gap-2">
          <span className="animate-spin inline-block w-4 h-4 border-2 border-[#0ea5e9] border-t-transparent rounded-full" />
          Rendering preview…
        </div>
      )}
      {!loading && error && (
        <div className="flex items-center justify-center h-48 text-[#94b8d4] text-xs text-center px-6">
          {error}
        </div>
      )}
      {!loading && !error && viewBox && (
        <div className="relative">
          {hasBothSides && (
            <div className="absolute top-2 left-2 z-10 flex gap-1 bg-[#020d1f]/85 rounded border border-[#1a3a5c] p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setSide('top')}
                className={`px-2 py-1 rounded transition-colors ${side === 'top' ? 'bg-[#0ea5e9] text-white' : 'text-[#94b8d4] hover:bg-[#0f2848]/50'}`}
              >
                Top
              </button>
              <button
                type="button"
                onClick={() => setSide('bottom')}
                className={`px-2 py-1 rounded transition-colors ${side === 'bottom' ? 'bg-[#0ea5e9] text-white' : 'text-[#94b8d4] hover:bg-[#0f2848]/50'}`}
              >
                Bottom
              </button>
            </div>
          )}
          <svg
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
            className="w-full h-auto max-h-72 rounded-lg bg-[#020d1f]"
          >
            <g transform={
              side === 'bottom'
                ? `translate(${boundsCenterX}, 0) scale(-1, 1) translate(${-boundsCenterX}, 0)`
                : undefined
            }>
              {shapePathD ? (
                <>
                  <defs>
                    <clipPath id="order-preview-outline-clip">
                      <path d={shapePathD} transform={shapeScale !== 1 ? `scale(${shapeScale})` : undefined} />
                    </clipPath>
                  </defs>
                  <g clipPath="url(#order-preview-outline-clip)">
                    <rect
                      x={viewBox.x - 0.2} y={viewBox.y - 0.2}
                      width={viewBox.width + 0.4} height={viewBox.height + 0.4}
                      fill={palette.substrate}
                    />
                  </g>
                </>
              ) : (
                <rect
                  x={viewBox.x - 0.2} y={viewBox.y - 0.2}
                  width={viewBox.width + 0.4} height={viewBox.height + 0.4}
                  fill={palette.substrate}
                />
              )}
              {sideLayers.map(layer => {
                const clipPair = maskClipPairs.find(p => p.maskLayerId === layer.id)
                if (clipPair) {
                  const copperLayer = layerById.get(clipPair.copperLayerId)
                  if (!copperLayer) return null
                  const maskId = `order-preview-mask-mask-${layer.id}`
                  return (
                    <React.Fragment key={layer.id}>
                      <RawSvgMask id={maskId} html={layer.svgData.svgFragment} />
                      <g mask={`url(#${maskId})`}>
                        <RawSvgGroup
                          style={{
                            color: getPcbColor('mask', layer.side, copperTint, silkColor),
                            opacity: PCB_OPACITY.copper ?? 1,
                          }}
                          html={copperLayer.svgData.svgFragment}
                        />
                      </g>
                    </React.Fragment>
                  )
                }
                return (
                  <RawSvgGroup
                    key={layer.id}
                    style={{
                      color: getPcbColor(layer.type, layer.side, copperTint, silkColor),
                      opacity: PCB_OPACITY[layer.type] ?? 1,
                    }}
                    html={layer.svgData.svgFragment}
                  />
                )
              })}
            </g>
          </svg>
        </div>
      )}
    </div>
  )
}
