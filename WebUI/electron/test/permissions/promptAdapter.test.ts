import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('electron', () => ({ app: { isPackaged: false } }))

import {
  handlePermissionsPromptResponse,
  permissionPromptsPending,
  requestPermissionsPrompt,
  resetPermissionsPromptAdapterForTest,
} from '../../permissions/promptAdapter'
import { resetKernelBusForTest, setKernelEventWindow } from '../../kernel/kernelBus'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'

let sent: Array<{ channel: string; payload: unknown }> = []

beforeEach(() => {
  resetKernelBusForTest()
  resetPermissionsPromptAdapterForTest()
  sent = []
  setKernelEventWindow({
    isDestroyed: () => false,
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
    },
  } as never)
})

afterEach(() => {
  resetPermissionsPromptAdapterForTest()
  resetKernelBusForTest()
})

describe('permissions prompt adapter cancellation', () => {
  it('rejects an owned prompt and asks the renderer to dismiss it', async () => {
    const controller = new AbortController()
    const pending = requestPermissionsPrompt<boolean>(
      { kind: 'download', models: [] },
      { signal: controller.signal },
    )
    const prompt = sent[0] as { channel: string; payload: PermissionsPromptPayload }
    expect(prompt.channel).toBe('permissions:prompt')
    controller.abort()

    expect(await Promise.race([pending, Promise.resolve('pending')])).toBe('pending')
    expect(sent.at(-1)).toEqual({
      channel: 'permissions:cancel',
      payload: { requestId: prompt.payload.requestId },
    })
    expect(permissionPromptsPending()).toBe(1)

    handlePermissionsPromptResponse({
      requestId: prompt.payload.requestId,
      error: 'Permission prompt cancelled',
      cancelled: true,
    })
    await expect(pending).rejects.toMatchObject({ cancelled: true })
    expect(permissionPromptsPending()).toBe(0)
  })

  it('does not cancel an unrelated prompt', async () => {
    const firstController = new AbortController()
    const first = requestPermissionsPrompt<boolean>(
      { kind: 'download', models: [] },
      { signal: firstController.signal },
    )
    const second = requestPermissionsPrompt<boolean>({
      kind: 'download',
      models: [],
    })
    const firstPayload = sent[0]!.payload as PermissionsPromptPayload
    const secondPayload = sent[1]!.payload as PermissionsPromptPayload

    firstController.abort()
    handlePermissionsPromptResponse({
      requestId: firstPayload.requestId,
      error: 'Permission prompt cancelled',
      cancelled: true,
    })
    await expect(first).rejects.toMatchObject({ cancelled: true })
    expect(permissionPromptsPending()).toBe(1)

    handlePermissionsPromptResponse({ requestId: secondPayload.requestId, result: true })
    await expect(second).resolves.toBe(true)
    expect(firstPayload.requestId).not.toBe(secondPayload.requestId)
  })
})
