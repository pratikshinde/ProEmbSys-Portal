import { db } from "@/lib/db"
import DfmTemplatesTable, { type DfmTemplateRow } from "@/components/admin/dfm-templates-table"
import { parseDfmRulesSafe } from "@/lib/dfm/types"

export default async function AdminDfmTemplatesPage() {
  const templates = await db.dfmTemplate.findMany({
    where: { scope: "SHARED" },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  })

  const rows: DfmTemplateRow[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    rules: parseDfmRulesSafe(t.rules),
    isDefault: t.isDefault,
    isSystem: t.isSystem,
  }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">DFM Templates</h1>
      <p className="text-sm text-muted-foreground">
        Shared rule sets that every customer can select when running a DFM check in the CAM Panelization
        tool — including visitors who aren&apos;t signed in. Customers can also save their own private
        templates; those aren&apos;t shown here. The built-in &ldquo;ProEmbSys Standard&rdquo; template is
        generated from our published fab capabilities and can&apos;t be deleted.
      </p>
      <DfmTemplatesTable initialTemplates={rows} />
    </div>
  )
}
