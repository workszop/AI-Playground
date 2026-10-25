import { useDialogStore } from '../store/dialogs'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { vramWarningGrantKey } from '@/types/permissionsIpc'
import { createCancellation } from '../errors/appError'

export { vramWarningGrantKey }

/**
 * Ask consent for downloading the given models and run the download.
 * Resolves when the download completed; rejects when it was declined or
 * failed. Downloads always require the desktop confirmation modal.
 */
export async function requestDownload(models: DownloadModelParam[]): Promise<void> {
  const api = window.electronAPI?.permissions
  if (!api?.requestDownload) {
    throw new Error('Permissions policy is unavailable (no electron bridge)')
  }
  const result = await api.requestDownload(cloneForIpc(models))
  if (result.success) return
  // A decline is a cancellation on the way out and has to still be one here, or
  // the caller reports "Could not start generation" for a turn the user stopped.
  if (result.cancelled) throw createCancellation({ technicalMessage: result.error })
  throw new Error(result.error)
}

/**
 * The gated-preset (high-memory / video-VRAM) warning. Resolves `true` when
 * the user confirms (or had remembered/pre-granted the warning away), `false`
 * when they cancel. A confirmed "do not show again" records a `remember`
 * grant under `vram-warning:<presetName>`.
 */
export async function requestVramWarning(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const api = window.electronAPI?.permissions
  if (!api?.requestVramWarning) {
    throw new Error('Permissions policy is unavailable (no electron bridge)')
  }
  const result = await api.requestVramWarning(req)
  if (!result.success) throw new Error(result.error)
  return result.confirmed
}

/** One-way guidance notice; `onConfirm` runs when the user clicks Confirm
 *  (e.g. opening the setup wizard to install what is missing). */
export function notify(message: string, onConfirm?: () => void): void {
  useDialogStore().showWarningDialog(message, () => onConfirm?.())
}
