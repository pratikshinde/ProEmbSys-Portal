import { db } from "@/lib/db"
import PanelTemplatesTable, { type PanelTemplateRow } from "@/components/admin/panel-templates-table"
import { parsePanelTemplateSettingsSafe } from "@/lib/panel-template/types"

export default async function AdminPanelTemplatesPage() {
  const templates = await db.panelTemplate.findMany({
    where: { scope: "SHARED" },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  })

  const rows: PanelTemplateRow[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    settings: parsePanelTemplateSettingsSafe(t.settings),
    isDefault: t.isDefault,
    isSystem: t.isSystem,
  }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Panelization Templates</h1>
      <p className="text-sm text-muted-foreground">
        Shared rib/tooling/routing/G-code/array setting bundles every customer can apply in the CAM
        Panelization tool — including visitors who aren&apos;t signed in. Customers can also save their
        own private templates; those aren&apos;t shown here. Settings themselves are authored by
        configuring the CAM tool and clicking &ldquo;Publish as Shared&rdquo; there — this page only
        manages naming, the default pick, and deletion. The built-in &ldquo;ProEmbSys Standard&rdquo;
        template is generated from the tool&apos;s own defaults and can&apos;t be deleted.
      </p>
      <PanelTemplatesTable initialTemplates={rows} />
    </div>
  )
}
