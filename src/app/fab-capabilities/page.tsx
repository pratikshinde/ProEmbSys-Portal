import Link from "next/link"

interface Spec {
  label: string
  standard: string
  advanced?: string
}

interface SpecGroup {
  title: string
  specs: Spec[]
}

const SPEC_GROUPS: SpecGroup[] = [
  {
    title: "General",
    specs: [
      { label: "Layer count", standard: "1–8 layers" },
      { label: "Max board size (single piece)", standard: "500mm × 500mm" },
      { label: "Board thickness", standard: "0.4mm – 3.2mm" },
      { label: "Board outline tolerance", standard: "±0.15mm" },
    ],
  },
  {
    title: "Copper & Traces",
    specs: [
      { label: "Min track width / spacing", standard: "0.1mm (4 mil)", advanced: "0.09mm (3.5 mil)" },
      { label: "Copper weight (outer layers)", standard: "1 oz – 3 oz" },
      { label: "Impedance control tolerance", standard: "±10%" },
    ],
  },
  {
    title: "Drilling",
    specs: [
      { label: "Min mechanical drill size", standard: "0.3mm", advanced: "0.2mm" },
      { label: "Min annular ring", standard: "0.15mm", advanced: "0.13mm" },
      { label: "Hole position tolerance", standard: "±0.075mm" },
      { label: "Max aspect ratio (board thickness : drill dia.)", standard: "10:1" },
    ],
  },
  {
    title: "Solder Mask & Silkscreen",
    specs: [
      { label: "Min solder mask clearance", standard: "0.05mm" },
      { label: "Min silkscreen line width", standard: "0.15mm" },
      { label: "Min silkscreen text height", standard: "0.8mm" },
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
    <div className="min-h-screen bg-background px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-muted-foreground hover:text-primary">
          &larr; Back to ProPCB
        </Link>
        <h1 className="mt-4 text-3xl font-bold text-foreground">PCB Fab Capabilities</h1>
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
