import { useDialogStore } from '../store/dialogs'
import { extractMessage, isCancellation } from '../errors/appError'

const PING_INTERVAL_MS = 30_000

function respond(payload: import('@/types/permissionsIpc').PermissionsPromptResponse): void {
  void window.electronAPI.permissions.respond(payload)
}

type ActivePrompt = {
  controller: AbortController
  cancel?: () => void
}

const activePrompts = new Map<string, ActivePrompt>()

async function handlePrompt(
  request: import('@/types/permissionsIpc').PermissionsPromptPayload,
): Promise<void> {
  const prompt: ActivePrompt = { controller: new AbortController() }
  activePrompts.set(request.requestId, prompt)
  const pings = setInterval(
    () => respond({ requestId: request.requestId, progress: true }),
    PING_INTERVAL_MS,
  )
  try {
    switch (request.kind) {
      case 'download': {
        const models = request.models as DownloadModelParam[]
        const dialogStore = useDialogStore()
        prompt.cancel = () => {
          dialogStore.cancelDownloadDialog?.(request.requestId)
        }
        await new Promise<void>((resolve, reject) => {
          dialogStore.showDownloadDialog(models, resolve, reject, {
            requestId: request.requestId,
          })
        })
        if (prompt.controller.signal.aborted) {
          respond({
            requestId: request.requestId,
            error: 'Permission prompt cancelled',
            cancelled: true,
          })
          return
        }
        respond({ requestId: request.requestId, result: true })
        break
      }
      case 'vram-warning': {
        const answer = await new Promise<{ confirmed: boolean; remember: boolean }>((resolve) => {
          useDialogStore().showWarningDialog(
            request.message,
            (dontShowAgain) => resolve({ confirmed: true, remember: Boolean(dontShowAgain) }),
            {
              dontShowAgainKey: request.presetName,
              onCancel: () => resolve({ confirmed: false, remember: false }),
            },
          )
        })
        respond({ requestId: request.requestId, result: answer })
        break
      }
    }
  } catch (error) {
    respond({
      requestId: request.requestId,
      error: extractMessage(error),
      cancelled: prompt.controller.signal.aborted || isCancellation(error),
    })
  } finally {
    clearInterval(pings)
    if (activePrompts.get(request.requestId) === prompt) activePrompts.delete(request.requestId)
  }
}

function handleCancel(
  request: import('@/types/permissionsIpc').PermissionsPromptCancelPayload,
): void {
  const prompt = activePrompts.get(request.requestId)
  if (!prompt) return
  prompt.controller.abort()
  prompt.cancel?.()
}

let started = false

export function startPermissionsAdapter(): void {
  if (started) return
  started = true
  window.electronAPI.permissions.onPrompt((payload) => {
    void handlePrompt(payload)
  })
  window.electronAPI.permissions.onCancel(handleCancel)
}

export function resetPermissionsAdapterForTest(): void {
  started = false
  for (const prompt of activePrompts.values()) prompt.controller.abort()
  activePrompts.clear()
}
