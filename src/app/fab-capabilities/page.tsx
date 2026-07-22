import { Navbar } from "@/components/portal-main"
import { FAB_CAPABILITIES as CAP } from "@/lib/fab-capabilities"

interface Spec {
  label: string
  standard: string
  advanced?: string
}

interface SpecGroup {
  title: string
  specs: Spec[]
}

// Numbers come from src/lib/fab-capabilities.ts so this page and the DFM
// engine's baseline template can't drift apart. Labels/formatting stay here
// (presentation), as do the prose-only rows (tolerances, finish list,
// panelization support) that no automated rule evaluates.
const SPEC_GROUPS: SpecGroup[] = [
  {
    title: "General",
    specs: [
      { label: "Layer count", standard: `${CAP.layerRange[0]}–${CAP.layerRange[1]} layers` },
      { label: "Max board size (single piece)", standard: `${CAP.maxBoardMm}mm × ${CAP.maxBoardMm}mm` },
      { label: "Board thickness", standard: `${CAP.boardThicknessMm[0]}mm – ${CAP.boardThicknessMm[1]}mm` },
      { label: "Board outline tolerance", standard: "±0.15mm" },
    ],
  },
  {
    title: "Copper & Traces",
    specs: [
      {
        label: "Min track width / spacing",
        standard: `${CAP.minTraceWidthMm.standard}mm (4 mil)`,
        advanced: `${CAP.minTraceWidthMm.advanced}mm (3.5 mil)`,
      },
      { label: "Copper weight (outer layers)", standard: "1 oz – 3 oz" },
      { label: "Impedance control tolerance", standard: "±10%" },
    ],
  },
  {
    title: "Drilling",
    specs: [
      {
        label: "Min mechanical drill size",
        standard: `${CAP.minDrillMm.standard}mm`,
        advanced: `${CAP.minDrillMm.advanced}mm`,
      },
      {
        label: "Min annular ring",
        standard: `${CAP.minAnnularRingMm.standard}mm`,
        advanced: `${CAP.minAnnularRingMm.advanced}mm`,
      },
      { label: "Hole position tolerance", standard: "±0.075mm" },
      { label: "Max aspect ratio (board thickness : drill dia.)", standard: `${CAP.maxAspectRatio}:1` },
    ],
  },
  {
    title: "Solder Mask & Silkscreen",
    specs: [
      { label: "Min solder mask clearance", standard: `${CAP.minMaskClearanceMm.standard}mm` },
      { label: "Min silkscreen line width", standard: `${CAP.minSilkLineWidthMm.standard}mm` },
      { label: "Min silkscreen text height", standard: `${CAP.minSilkTextHeightMm.standard}mm` },
    ],
  },
  {
    title: "Surface Finish",
    specs: [
      { label: "Available finishes", standard: "HASL (Lead-free), ENIG, OSP, Immersion Silver, Hard Gold" },
    ],
  },
  {
    title: "Panelization",
    specs: [
      { label: "V-scoring", standard: "Supported, straight cuts only" },
      { label: "Tab routing / mousebites", standard: "Supported" },
      { label: "Fiducials & tooling holes", standard: "Supported, customer-configurable" },
    ],
  },
]

export default function FabCapabilitiesPage() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-bold text-foreground">PCB Fab Capabilities</h1>
        <p className="mt-2 text-muted-foreground">
          Standard process capabilities for boards fabricated by ProEmbSys Technologies. If your design falls
          outside these specs, contact us before ordering — some advanced specs are available on request.
        </p>

        <div className="mt-10 flex flex-col gap-8">
          {SPEC_GROUPS.map((group) => (
            <div key={group.title}>
              <h2 className="mb-3 text-lg font-semibold text-foreground">{group.title}</h2>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <tbody>
                    {group.specs.map((spec, i) => (
                      <tr key={spec.label} className={i > 0 ? "border-t border-border" : undefined}>
                        <td className="w-1/2 bg-muted px-4 py-3 font-medium text-foreground">{spec.label}</td>
                        <td className="px-4 py-3 text-foreground">
                          {spec.standard}
                          {spec.advanced && (
                            <span className="ml-2 text-xs text-muted-foreground">(advanced: {spec.advanced})</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
