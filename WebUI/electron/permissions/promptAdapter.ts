import { randomUUID } from 'node:crypto'
import { getKernelEventWindow } from '../kernel/kernelBus'
import { typedSend } from '../kernel/typedIpc'
import type { PermissionsPromptBody, PermissionsPromptResponse } from '@/types/permissionsIpc'

type PendingRequest = {
  requestId: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  onProgress?: () => void
  onAbort?: () => void
  removeAbort?: () => void
  cancelled?: boolean
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
    const onAbort = () => {
      const current = pending.get(requestId)
      if (!current) return
      current.cancelled = true
      try {
        typedSend(win.webContents, 'permissions:cancel', { requestId })
      } catch {
        // The window may have been destroyed at the same time as cancellation.
        pending.delete(requestId)
        current.onAbort = undefined
        current.removeAbort?.()
        current.removeAbort = undefined
        current.reject(cancellableError('Permission prompt cancelled', true))
      }
    }
    entry.onAbort = onAbort
    entry.removeAbort = () => options.signal?.removeEventListener('abort', onAbort)
    pending.set(requestId, entry)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      typedSend(win.webContents, 'permissions:prompt', { ...payload, requestId })
    } catch (error) {
      pending.delete(requestId)
      entry.removeAbort?.()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
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
    if (!entry.cancelled) entry.onProgress?.()
    return
  }
  pending.delete(payload.requestId)
  entry.onAbort = undefined
  entry.removeAbort?.()
  entry.removeAbort = undefined
  if (entry.cancelled) {
    entry.reject(cancellableError('Permission prompt cancelled', true))
    return
  }
  if ('error' in payload) {
    entry.reject(cancellableError(payload.error, payload.cancelled === true))
  } else {
    entry.resolve(payload.result)
  }
}

export function rejectAllPermissionPrompts(reason: string): void {
  for (const entry of pending.values()) {
    entry.onAbort = undefined
    entry.removeAbort?.()
    entry.reject(new Error(reason))
  }
  pending.clear()
}

export function resetPermissionsPromptAdapterForTest(): void {
  for (const entry of pending.values()) {
    entry.onAbort = undefined
    entry.removeAbort?.()
  }
  pending.clear()
}

export function permissionPromptsPending(): number {
  return pending.size
}
