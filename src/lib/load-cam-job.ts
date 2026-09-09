import { useAppStore, type CamJobSnapshot } from './store'

/**
 * Fetches a saved CAM job and hydrates the store from it — the one place
 * this sequence is implemented, shared by the `?load=` effect in
 * PanelizationPage and the in-tool quick-load picker (export-panel.tsx) so
 * neither can drift from the other.
 */
export async function loadCamJobById(jobId: string): Promise<
  { ok: true; name: string; missingFiles: string[] } | { ok: false; error: string }
> {
  const res = await fetch(`/api/cam-jobs/${jobId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    return { ok: false, error: body?.error ?? 'Could not load that job.' }
  }
  const data: {
    name: string
    missingFiles?: string[]
    config: CamJobSnapshot & { files: (CamJobSnapshot['files'][number] & { content: string | null })[] }
    hadRouting?: boolean
    hadGcode?: boolean
  } = await res.json()

  const contentByLayerFileId: Record<string, string> = {}
  for (const f of data.config.files) {
    if (f.content !== null) contentByLayerFileId[f.layerFileId] = f.content
  }

  const { missingFiles } = await useAppStore.getState().loadCamJobSnapshot(data.config, contentByLayerFileId)
  // Union of what the server couldn't read and what the store couldn't
  // hydrate — in practice the same set (the store's gap is a direct
  // consequence of the server's), but taking the union rather than
  // trusting just one side means a future direct caller of
  // loadCamJobSnapshot (bypassing this fetch) still gets a correct report.
  const allMissing = Array.from(new Set([...(data.missingFiles ?? []), ...missingFiles]))
  // loadCamJobSnapshot's own reset clears lastSavedJobId to null; set the
  // real id now that the load actually succeeded, so Sharing (which
  // requires a saved job) becomes available immediately after loading one,
  // not only after a fresh Save.
  useAppStore.getState().setLastSavedJobId(jobId)

  // Restore the computed view the job was actually SAVED in, rather than
  // leaving the tool back at "click Create Panel" — loadCamJobSnapshot
  // deliberately nulls panelResult/routingResult/gcodeFiles for a fresh
  // import (nothing to recompute yet), but a reload has everything it needs
  // already sitting in the just-restored config, so there's no reason to
  // make the user re-click three buttons to see what they explicitly saved.
  //
  // computePanelResult() always runs — it's synchronous, cheap (the same
  // call "Create Panel" makes on click), and handles both camMode branches.
  // Routing/G-code are recomputed only when this job actually had them
  // generated as of its last save (hadRouting/hadGcode, from
  // CamJob.routingGeneratedAt/gcodeGeneratedAt) — most jobs never touch
  // those tabs, and routing (contour tracing especially) isn't free enough
  // to run blindly on every load. Both recomputations are deterministic —
  // the exact same saved config/layers that produced the original result —
  // so this is a recompute, not a guess; only the TRIGGER moved, from "user
  // click" to "successful load of a job that had this before".
  if (allMissing.length === 0) {
    useAppStore.getState().computePanelResult()
    if (data.hadRouting && useAppStore.getState().panelResult) {
      try {
        await useAppStore.getState().generateRouting()
      } catch (err) {
        console.warn('[loadCamJobById] routing regeneration failed on load:', err)
      }
      if (data.hadGcode && useAppStore.getState().routingResult) {
        useAppStore.getState().generateGcodeFilesAction()
      }
    }
  }

  return { ok: true, name: data.name, missingFiles: allMissing }
}
