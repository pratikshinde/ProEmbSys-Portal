'use client'

/**
 * CNC bed + Multi-Panel Array cell placement preview, shown in the main
 * canvas area instead of the usual Gerber/panel viewer while the G-Code tab
 * is active — the panel/board artwork isn't the useful thing to look at
 * here, the physical layout on the machine bed is. Pure geometry (no Gerber
 * rendering at all): a dashed CNC-travel rectangle, one solid rectangle per
 * array cell (the material block, or the panel itself when no material cell
 * is configured), and — only when a material cell IS configured — a smaller
 * inset rectangle showing where the panel sits centered within it.
 *
 * Static + fit-to-view, no pan/zoom — same "intentionally lighter-weight
 * preview" precedent as board-preview.tsx.
 */

import React from 'react'
import { useAppStore } from '@/lib/store'

const CNC_STROKE = '#4a6f94'
const CELL_STROKE = '#0ea5e9'
const CELL_FILL = 'rgba(14, 165, 233, 0.10)'
const PANEL_STROKE = '#22c55e'
const PANEL_FILL = 'rgba(34, 197, 94, 0.18)'
const LABEL_FILL = '#94b8d4'

export default function ArrayLayoutCanvas() {
  const panelResult = useAppStore(s => s.panelResult)
  const panelArrayConfig = useAppStore(s => s.panelArrayConfig)
  const panelArrayResult = useAppStore(s => s.panelArrayResult)

  if (!panelResult) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-[#4a6f94]">
        Create a panel on the Panel Config tab first.
      </div>
    )
  }

  if (!panelArrayConfig.enabled) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-[#4a6f94] text-center px-6">
        Enable Multi-Panel Array in the sidebar to preview the CNC bed and cell layout here.
      </div>
    )
  }

  const cncW = panelArrayConfig.cncMaxXmm
  const cncH = panelArrayConfig.cncMaxYmm

  const effPanelW = panelArrayConfig.rotatePanel90 ? panelResult.panelHeight : panelResult.panelWidth
  const effPanelH = panelArrayConfig.rotatePanel90 ? panelResult.panelWidth : panelResult.panelHeight

  // Fit whichever is bigger — the CNC bed, or a computed layout that
  // (via manual override) may legitimately exceed it.
  const boundsW = Math.max(cncW, panelArrayResult?.sheetWidthMm ?? 0)
  const boundsH = Math.max(cncH, panelArrayResult?.sheetHeightMm ?? 0)
  const padding = Math.max(boundsW, boundsH) * 0.08
  const viewBox = `${-padding} ${-padding} ${boundsW + padding * 2} ${boundsH + padding * 2}`
  // Gerber/array coordinates are Y-up; SVG is Y-down. Flip by drawing into a
  // group transformed to match, so every rect below is authored in plain
  // "Y increases upward" terms.
  const flipTransform = `translate(0, ${boundsH}) scale(1, -1)`

  const strokeW = Math.max(boundsW, boundsH) * 0.0025
  const fontSize = Math.max(boundsW, boundsH) * 0.022

  return (
    <div className="w-full h-full flex flex-col bg-[#061420]">
      <div className="px-3 py-2 border-b border-[#1a3a5c] text-[10px] font-mono text-[#94b8d4] flex flex-wrap gap-x-4 gap-y-0.5">
        <span>CNC: {cncW.toFixed(0)} × {cncH.toFixed(0)}mm</span>
        {panelArrayResult && (
          <>
            <span>Layout: {panelArrayResult.cols} × {panelArrayResult.rows} = {panelArrayResult.totalPanels} panels</span>
            <span>Cell: {panelArrayResult.cellWidthMm.toFixed(1)} × {panelArrayResult.cellHeightMm.toFixed(1)}mm</span>
            <span>Sheet: {panelArrayResult.sheetWidthMm.toFixed(1)} × {panelArrayResult.sheetHeightMm.toFixed(1)}mm</span>
            {panelArrayResult.exceedsBounds && <span className="text-yellow-400">exceeds CNC bound</span>}
          </>
        )}
        {!panelArrayResult && <span className="text-[#4a6f94]">No layout computed yet — click Generate Array Files.</span>}
      </div>
      <div className="flex-1 min-h-0">
        <svg viewBox={viewBox} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
          <g transform={flipTransform}>
            {/* CNC travel bound */}
            <rect
              x={0} y={0} width={cncW} height={cncH}
              fill="none" stroke={CNC_STROKE} strokeWidth={strokeW} strokeDasharray={`${strokeW * 4} ${strokeW * 3}`}
            />
            <text
              x={strokeW * 3} y={cncH - strokeW * 3} fontSize={fontSize * 0.9} fill={LABEL_FILL}
              transform={`scale(1, -1) translate(0, ${-2 * (cncH - strokeW * 3)})`}
            >
              CNC travel
            </text>

            {panelArrayResult && panelArrayResult.cells.map(cell => {
              const cellW = panelArrayResult.cellWidthMm
              const cellH = panelArrayResult.cellHeightMm
              const showPanelInset = panelArrayResult.panelOffsetXMm > 0 || panelArrayResult.panelOffsetYMm > 0
              return (
                <g key={`${cell.col}-${cell.row}`}>
                  <rect
                    x={cell.x} y={cell.y} width={cellW} height={cellH}
                    fill={CELL_FILL} stroke={CELL_STROKE} strokeWidth={strokeW}
                  />
                  {showPanelInset && (
                    <rect
                      x={cell.x + panelArrayResult.panelOffsetXMm}
                      y={cell.y + panelArrayResult.panelOffsetYMm}
                      width={effPanelW} height={effPanelH}
                      fill={PANEL_FILL} stroke={PANEL_STROKE} strokeWidth={strokeW * 0.7}
                    />
                  )}
                  <text
                    x={cell.x + cellW / 2} y={cell.y + cellH / 2} fontSize={fontSize}
                    fill={LABEL_FILL} textAnchor="middle" dominantBaseline="middle"
                    transform={`scale(1, -1) translate(0, ${-2 * (cell.y + cellH / 2)})`}
                  >
                    {cell.col},{cell.row}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}
