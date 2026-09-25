'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  resolveSlotDrillSettings,
  MIN_SLOT_DRILL_PITCH_RATIO,
  MAX_SLOT_DRILL_PITCH_RATIO,
} from '@/lib/drill-slots'

/**
 * "Drill slots" setting — one control, rendered by BOTH the Info & Export tab
 * (the panelized Excellon export) and the G-Code tab (the drilling programs).
 * It edits a single `PanelConfig` field pair, so the two tabs can never
 * disagree about how a slot is output.
 *
 * Reads through `resolveSlotDrillSettings`, not the raw fields: a CAM job saved
 * before this setting existed carries neither, and must show (and behave) as
 * the default — multi-drill ON — rather than as "off".
 */
export default function SlotDrillControl() {
  const panelConfig = useAppStore(s => s.panelConfig)
  const updatePanelConfig = useAppStore(s => s.updatePanelConfig)
  const layers = useAppStore(s => s.layers)

  const settings = resolveSlotDrillSettings(panelConfig)
  const slotCount = layers.reduce((n, l) => n + (l.type === 'drill' ? (l.parsedLayer.drillSlots?.length ?? 0) : 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label
          className="text-xs text-[#94b8d4]"
          title="Drilling machines that can only drill (not mill) cut a slot as a row of overlapping round holes. On: every slot is output as multiple drill hits of the slot's own diameter — in the panelized Excellon export and in the G-code drilling programs. Off: native slots (Excellon G85 / a lateral G-code cut)."
        >
          Output slots as multiple drills
        </Label>
        <Switch
          checked={settings.asDrills}
          onCheckedChange={v => updatePanelConfig({ slotsAsDrills: v })}
          className="scale-75"
        />
      </div>

      {settings.asDrills && (
        <div className="mt-2">
          <Label className="text-[10px] text-[#4a6f94]">Hit spacing (fraction of drill diameter)</Label>
          <Input
            type="number"
            min={MIN_SLOT_DRILL_PITCH_RATIO}
            max={MAX_SLOT_DRILL_PITCH_RATIO}
            step={0.05}
            value={settings.pitchRatio}
            onChange={e => {
              const v = parseFloat(e.target.value)
              if (Number.isFinite(v)) {
                updatePanelConfig({ slotDrillPitchRatio: Math.min(MAX_SLOT_DRILL_PITCH_RATIO, Math.max(MIN_SLOT_DRILL_PITCH_RATIO, v)) })
              }
            }}
            className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
          />
        </div>
      )}

      <p className="text-[10px] text-[#4a6f94] mt-1.5">
        {settings.asDrills
          ? `Each slot is drilled as overlapping round holes at ≤${Math.round(settings.pitchRatio * 100)}% of the drill diameter apart, both ends included.`
          : 'Slots are output as native slots (Excellon G85 / a lateral G-code cut).'}
        {slotCount > 0 ? ` ${slotCount} slot${slotCount === 1 ? '' : 's'} in the loaded drill file${slotCount === 1 ? '' : 's'}.` : ''}
      </p>
    </div>
  )
}
