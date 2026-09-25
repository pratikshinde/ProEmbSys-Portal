/**
 * Regression gate for drill-slot handling — no database, no browser:
 *
 *   npx tsx scripts/verify-drill-slots.mts
 *
 *  A. The parser reads KiCad route-mode slots (G00 / M15 / G01 / M16) as SLOTS
 *     — the reported bug was that each became two round holes.
 *  B. `slotDrillPoints` really does cut the slot out: full coverage, exact
 *     endpoints, bounded spacing. Includes a 5 x 3 mm slot.
 *  C. Settings resolution (an old saved job with no field must get the DEFAULT).
 */
import { parseExcellonDrill, normalizeExcellonRouteSlots } from '../src/lib/gerber-parser'
import {
  slotDrillPoints, expandSlotGroupsToHoles, mergeHoleGroups, resolveSlotDrillSettings,
  DEFAULT_SLOT_DRILL_PITCH_RATIO,
} from '../src/lib/drill-slots'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol

// ── A. Parser ────────────────────────────────────────────────────────────────
const kicad = [
  'M48', 'INCH,LZ', 'T1C0.0591', 'T2C0.0315', '%', 'G90', 'G05',
  'T2', 'X10000Y-10000',
  'T1',
  'G00X20000Y-20000', 'M15', 'G01X20000Y-30000', 'M16', 'G05',
  'M30',
].join('\n')
{
  const p = parseExcellonDrill(kicad, 'route.drl')
  const flashes = p.commands.filter(c => c.type === 'flash').length
  check('A1 route-mode slot is ONE slot, not two holes', (p.drillSlots?.length ?? 0) === 1 && flashes === 1,
    `${p.drillSlots?.length ?? 0} slot(s), ${flashes} flash(es) — the ordinary hole only`)
  const s = p.drillSlots?.[0]
  check('A2 slot endpoints decoded exactly (inch -> mm)',
    !!s && near(s.start.x, 50.8) && near(s.start.y, -50.8) && near(s.end.x, 50.8) && near(s.end.y, -76.2),
    s ? `(${s.start.x}, ${s.start.y}) -> (${s.end.x}, ${s.end.y})` : 'no slot')
  check('A3 slot diameter is the tool diameter', !!s && near(s.diameterMm, 0.0591 * 25.4, 1e-4), s ? `${s.diameterMm}` : '')
}
{
  // Several G01 segments between one M15/M16 = a chain of slots sharing joints.
  const chain = 'M48\nINCH,LZ\nT1C0.05\n%\nG05\nT1\nG00X10000Y-10000\nM15\nG01X10000Y-20000\nG01X20000Y-20000\nM16\nG05\nM30'
  const p = parseExcellonDrill(chain, 'chain.drl')
  check('A4 a G01 chain becomes one slot per segment', p.drillSlots?.length === 2, `${p.drillSlots?.length}`)
}
{
  // Modal axis: a G01 that names only Y keeps the previous X.
  const modal = 'M48\nINCH,LZ\nT1C0.05\n%\nG05\nT1\nG00X10000Y-10000\nM15\nG01Y-20000\nM16\nG05\nM30'
  const p = parseExcellonDrill(modal, 'modal.drl')
  const s = p.drillSlots?.[0]
  check('A5 an omitted axis on G01 is modal', !!s && near(s.end.x, s.start.x) && near(s.end.y, -50.8), s ? `end=(${s.end.x}, ${s.end.y})` : 'no slot')
}
{
  // Conservative: a G00 that is NOT followed by M15, and an unterminated block,
  // must be left exactly as before (plain hits), not silently reinterpreted.
  const notRoute = 'M48\nINCH,LZ\nT1C0.05\n%\nG05\nT1\nG00X10000Y-10000\nX20000Y-20000\nM30'
  check('A6 G00 without M15 is untouched (legacy behaviour)', normalizeExcellonRouteSlots(notRoute).converted === 0)
  const open = 'M48\nINCH,LZ\nT1C0.05\n%\nG05\nT1\nG00X10000Y-10000\nM15\nG01X10000Y-20000\nM30'
  check('A7 an unterminated route block is untouched', normalizeExcellonRouteSlots(open).converted === 0)
  const arc = 'M48\nINCH,LZ\nT1C0.05\n%\nG05\nT1\nG00X10000Y-10000\nM15\nG02X20000Y-10000A5000\nM16\nM30'
  check('A8 an arc (G02) block is untouched — not misread as a straight slot', normalizeExcellonRouteSlots(arc).converted === 0)
}
{
  // G85 files must keep working exactly as before.
  const g85 = 'M48\nINCH,LZ\nT1C0.0591\n%\nG05\nT1\nX20000Y-20000G85X20000Y-30000\nM30'
  const p = parseExcellonDrill(g85, 'g85.drl')
  check('A9 native G85 slots still parse as before', p.drillSlots?.length === 1 && p.commands.length === 0)
}
{
  // The Eagle-TZ correction re-decodes coordinates; slots must be re-decoded WITH
  // them. Declared TZ over leading-zero data (this is what KiCad 10 really emits).
  const tz = [
    'M48', 'INCH,TZ', 'T1C0.0591', '%', 'G90', 'G05', 'T1',
    'X45748Y-31260', 'X45988Y-42677', 'X46457Y-31220',
    'G00X51555Y-38425', 'M15', 'G01X51555Y-38819', 'M16', 'G05', 'M30',
  ].join('\n')
  const p = parseExcellonDrill(tz, 'tz.drl')
  const s = p.drillSlots?.[0]
  check('A10 Eagle-TZ-corrected file: slot re-decoded with the holes',
    !!p.drillMeta?.eagleTzCorrected && !!s && near(s.start.x, 5.1555 * 25.4, 1e-3) && near(s.end.y, -3.8819 * 25.4, 1e-3),
    s ? `start.x=${s.start.x.toFixed(3)} (expect ${(5.1555 * 25.4).toFixed(3)}), eagleTzCorrected=${p.drillMeta?.eagleTzCorrected}` : 'no slot')
}

// ── B. Hit generation ────────────────────────────────────────────────────────
const D = 3 // mm: a 5 x 3 mm slot = 3 mm wide, 5 mm long overall -> 2 mm centre-to-centre
const slot5x3 = { start: { x: 10, y: 20 }, end: { x: 12, y: 20 } }
{
  const pts = slotDrillPoints(slot5x3, D, DEFAULT_SLOT_DRILL_PITCH_RATIO)
  check('B1 5x3 mm slot: MORE than two drills (the reported bug was exactly two)', pts.length > 2, `${pts.length} hits`)
  check('B2 both endpoints hit exactly (they form the rounded ends)',
    near(pts[0].x, 10) && near(pts[0].y, 20) && near(pts[pts.length - 1].x, 12) && near(pts[pts.length - 1].y, 20))
  let maxPitch = 0
  for (let i = 1; i < pts.length; i++) maxPitch = Math.max(maxPitch, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  check('B3 spacing never exceeds pitchRatio x diameter', maxPitch <= DEFAULT_SLOT_DRILL_PITCH_RATIO * D + 1e-9, `max pitch ${maxPitch.toFixed(4)} <= ${(DEFAULT_SLOT_DRILL_PITCH_RATIO * D).toFixed(4)}`)

  // Real coverage: sample the slot's own stadium outline, shrunk by the worst scallop.
  const r = D / 2
  const cusp = r - Math.sqrt(r * r - (maxPitch / 2) ** 2)
  let uncovered = 0
  let sampled = 0
  for (let x = 10 - r; x <= 12 + r; x += 0.05) {
    for (let y = 20 - r; y <= 20 + r; y += 0.05) {
      // inside the ideal stadium (segment 10..12 swept by radius r), shrunk by the scallop
      const cx = Math.min(12, Math.max(10, x))
      const inside = Math.hypot(x - cx, y - 20) <= r - cusp - 1e-9
      if (!inside) continue
      sampled++
      if (!pts.some(p => Math.hypot(p.x - x, p.y - y) <= r + 1e-9)) uncovered++
    }
  }
  check('B4 the hits cut out the whole slot (every interior point covered)', sampled > 1000 && uncovered === 0, `${sampled} points sampled, ${uncovered} uncovered, worst scallop ${cusp.toFixed(3)} mm`)
}
{
  const diag = slotDrillPoints({ start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }, 1, 0.5)
  check('B5 diagonal slot: uniform steps, exact endpoints', near(diag[diag.length - 1].x, 3) && near(diag[diag.length - 1].y, 4) &&
    diag.slice(1).every((p, i) => near(Math.hypot(p.x - diag[i].x, p.y - diag[i].y), 5 / (diag.length - 1), 1e-9)), `${diag.length} hits over 5 mm`)
  check('B6 zero-length slot = a single hole', slotDrillPoints({ start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }, 1, 0.5).length === 1)
  check('B7 non-positive diameter -> nothing', slotDrillPoints(slot5x3, 0, 0.5).length === 0)
  check('B8 NaN coordinates -> nothing (never a silent NaN hole)', slotDrillPoints({ start: { x: NaN, y: 0 }, end: { x: 1, y: 0 } }, 1, 0.5).length === 0)
  const exact = slotDrillPoints({ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, 1, 0.5)
  check('B9 length an exact multiple of the pitch does not gain a spurious interval', exact.length === 3, `${exact.length} hits`)
}
{
  const groups = expandSlotGroupsToHoles([{ diameterMm: 1, slots: [
    { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
    { start: { x: 2, y: 0 }, end: { x: 2, y: 2 } }, // shares the joint (2,0)
  ] }], 0.5)
  const n = groups[0].holes.length
  const unique = new Set(groups[0].holes.map(h => `${h.x.toFixed(4)},${h.y.toFixed(4)}`)).size
  check('B10 a shared joint between chained slots is drilled once', n === unique, `${n} hits, ${unique} unique`)
  const merged = mergeHoleGroups([{ diameterMm: 2, holes: [{ x: 1, y: 1 }] }], groups)
  check('B11 slot hits merge into the ordinary hole list by diameter, ascending', merged.map(g => g.diameterMm).join() === '1,2')
}

// ── C. Settings ──────────────────────────────────────────────────────────────
check('C1 an old saved job (no fields) resolves to the DEFAULT — multi-drill ON', resolveSlotDrillSettings({}).asDrills === true && resolveSlotDrillSettings(undefined).asDrills === true)
check('C2 explicit false turns it off', resolveSlotDrillSettings({ slotsAsDrills: false }).asDrills === false)
check('C3 out-of-range / non-finite pitch is clamped, never trusted',
  resolveSlotDrillSettings({ slotDrillPitchRatio: 0 }).pitchRatio === 0.1 &&
  resolveSlotDrillSettings({ slotDrillPitchRatio: 9 }).pitchRatio === 1 &&
  resolveSlotDrillSettings({ slotDrillPitchRatio: NaN }).pitchRatio === DEFAULT_SLOT_DRILL_PITCH_RATIO)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
