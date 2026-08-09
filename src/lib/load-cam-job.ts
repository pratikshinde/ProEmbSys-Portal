import { useAppStore, type CamJobSnapshot } from './store'

/**
 * Fetches a saved CAM job and hydrates the store from it — the one place
 * this sequence is implemented, shared by the `?load=` effect in
 * PanelizationPage and the in-tool quick-load picker (export-panel.tsx) so
 * neither can drift from the other.
 */
export async function loadCamJobById(jobId: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const res = await fetch(`/api/cam-jobs/${jobId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    return { ok: false, error: body?.error ?? 'Could not load that job.' }
  }
  const data: { name: string; config: CamJobSnapshot & { files: (CamJobSnapshot['files'][number] & { content: string | null })[] } } = await res.json()

  const contentByLayerFileId: Record<string, string> = {}
  for (const f of data.config.files) {
    if (f.content !== null) contentByLayerFileId[f.layerFileId] = f.content
  }

  await useAppStore.getState().loadCamJobSnapshot(data.config, contentByLayerFileId)
  return { ok: true, name: data.name }
}
