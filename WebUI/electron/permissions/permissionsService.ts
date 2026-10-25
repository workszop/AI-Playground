import {
  vramWarningGrantKey,
  type PermissionGrant,
  type PermissionGrantOrigin,
} from '@/types/permissionsIpc'
import {
  grantPermission,
  hasPermissionGrant,
  listPermissionGrants,
  migratePermissionGrants,
  revokePermissionGrant,
} from '../persist/grantsStore'
import { requestPermissionsPrompt } from './promptAdapter'

export type RequestDownloadOptions = {
  onProgress?: () => void
  signal?: AbortSignal
}

export async function requestDownloadConsent(
  models: unknown[],
  options: RequestDownloadOptions = {},
): Promise<void> {
  await requestPermissionsPrompt<void>(
    { kind: 'download', models },
    { onProgress: options.onProgress, signal: options.signal },
  )
}

export async function requestVramWarningConsent(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const key = vramWarningGrantKey(req.presetName)
  if (await hasPermissionGrant(key)) return true
  const answer = await requestPermissionsPrompt<{ confirmed: boolean; remember: boolean }>({
    kind: 'vram-warning',
    presetName: req.presetName,
    message: req.message,
  })
  if (answer.confirmed && answer.remember) {
    await grantPermission(key, 'remember')
  }
  return answer.confirmed === true
}

export async function listGrants(): Promise<PermissionGrant[]> {
  return listPermissionGrants()
}

export async function grant(key: string, origin: PermissionGrantOrigin): Promise<PermissionGrant> {
  return grantPermission(key, origin)
}

export async function revoke(key: string): Promise<void> {
  return revokePermissionGrant(key)
}

export async function migrateGrants(incoming: Record<string, PermissionGrant>): Promise<number> {
  return migratePermissionGrants(incoming)
}
