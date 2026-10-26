import { randomUUID } from 'node:crypto'
import { getKernelEventWindow } from '../kernel/kernelBus'
import { typedSend } from '../kernel/typedIpc'
import type { PermissionsPromptBody, PermissionsPromptResponse } from '@/types/permissionsIpc'

type PendingRequest = {
  requestId: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onProgress?: () => void
  removeAbort?: () => void
}

const pending = new Map<string, PendingRequest>()

export type PromptAdapterOptions = {
  onProgress?: () => void
  signal?: AbortSignal
}

export function requestPermissionsPrompt<T>(
  payload: PermissionsPromptBody,
  options: PromptAdapterOptions = {},
): Promise<T> {
  const win = getKernelEventWindow()
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('No renderer window available for the permission prompt'))
  }
  if (options.signal?.aborted) {
    return Promise.reject(cancellableError('Permission prompt cancelled', true))
  }
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const entry: PendingRequest = {
      requestId,
      resolve: resolve as (result: unknown) => void,
      reject,
      onProgress: options.onProgress,
    }
    // A reloaded renderer no longer knows the request, so the abort cannot wait for its reply.
    const onAbort = () => {
      if (pending.get(requestId) !== entry) return
      settle(entry)
      try {
        typedSend(win.webContents, 'permissions:cancel', { requestId })
      } catch {
        // The window may have been destroyed at the same time as cancellation.
      }
      reject(cancellableError('Permission prompt cancelled', true))
    }
    entry.removeAbort = () => options.signal?.removeEventListener('abort', onAbort)
    pending.set(requestId, entry)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      typedSend(win.webContents, 'permissions:prompt', { ...payload, requestId })
    } catch (error) {
      settle(entry)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function settle(entry: PendingRequest): void {
  pending.delete(entry.requestId)
  entry.removeAbort?.()
  entry.removeAbort = undefined
}

export type CancellableError = Error & { cancelled?: boolean }

/** Keeps "the user declined" distinguishable from "it broke" on the way back. */
function cancellableError(message: string, cancelled: boolean): CancellableError {
  const error: CancellableError = new Error(message)
  if (cancelled) error.cancelled = true
  return error
}

export function handlePermissionsPromptResponse(payload: PermissionsPromptResponse): void {
  if (typeof payload?.requestId !== 'string') return
  const entry = pending.get(payload.requestId)
  if (!entry) return
  if ('progress' in payload) {
    entry.onProgress?.()
    return
  }
  settle(entry)
  if ('error' in payload) {
    entry.reject(cancellableError(payload.error, payload.cancelled === true))
  } else {
    entry.resolve(payload.result)
  }
}

export function rejectAllPermissionPrompts(reason: string): void {
  for (const entry of [...pending.values()]) {
    settle(entry)
    entry.reject(new Error(reason))
  }
}

export function resetPermissionsPromptAdapterForTest(): void {
  for (const entry of [...pending.values()]) settle(entry)
}

export function permissionPromptsPending(): number {
  return pending.size
}
