import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PermissionsPromptPayload } from '@/types/permissionsIpc'
import { createCancellation } from '@/assets/js/errors/appError'

const showDownloadDialog = vi.fn()
const cancelDownloadDialog = vi.fn()
const showWarningDialog = vi.fn()
const respondMock = vi.fn(async () => {})
const onPromptMock = vi.fn<(callback: (payload: PermissionsPromptPayload) => void) => () => void>()
const onCancelMock = vi.fn<(callback: (payload: { requestId: string }) => void) => () => void>()

vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showDownloadDialog, cancelDownloadDialog, showWarningDialog }),
}))

vi.stubGlobal('window', {
  electronAPI: {
    permissions: {
      onPrompt: onPromptMock,
      onCancel: onCancelMock,
      respond: respondMock,
    },
  },
})

const { startPermissionsAdapter, resetPermissionsAdapterForTest } =
  await import('@/assets/js/permissions/permissionsAdapter')

let handler: ((payload: PermissionsPromptPayload) => void) | undefined

beforeEach(() => {
  setActivePinia(createPinia())
  resetPermissionsAdapterForTest()
  vi.clearAllMocks()
  onPromptMock.mockImplementation((callback) => {
    handler = callback
    return () => {}
  })
  onCancelMock.mockImplementation(() => () => {})
  startPermissionsAdapter()
})

afterEach(() => {
  resetPermissionsAdapterForTest()
  handler = undefined
})

describe('permissions prompt adapter', () => {
  it('prompts through the desktop download modal', async () => {
    const models = [{ repo_id: 'test/model' }] as DownloadModelParam[]
    const pending = new Promise<void>((resolve) => {
      respondMock.mockImplementation(async () => resolve())
    })
    handler?.({ requestId: 'r2', kind: 'download', models })
    await vi.waitFor(() => expect(showDownloadDialog).toHaveBeenCalledTimes(1))
    const [list, onSuccess] = showDownloadDialog.mock.calls[0]
    expect(list).toBe(models)
    onSuccess()
    await pending
    expect(respondMock).toHaveBeenCalledWith({ requestId: 'r2', result: true })
  })

  it('cancels only the owned download and waits for its cleanup acknowledgement', async () => {
    handler?.({ requestId: 'r3', kind: 'download', models: [] })
    const onCancel = onCancelMock.mock.calls[0][0]
    onCancel({ requestId: 'unrelated' })
    expect(cancelDownloadDialog).not.toHaveBeenCalled()
    onCancel({ requestId: 'r3' })
    expect(cancelDownloadDialog).toHaveBeenCalledExactlyOnceWith('r3')
    expect(respondMock).not.toHaveBeenCalled()
    showDownloadDialog.mock.calls[0][2](createCancellation())
    await vi.waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'r3', cancelled: true }),
      ),
    )
  })

  it('forwards a declined download as the request error', async () => {
    showDownloadDialog.mockImplementation((_list, _ok, fail) => fail(new Error('cancelled')))
    handler?.({
      requestId: 'r4',
      kind: 'download',
      models: [{ repo_id: 'x' }],
    })
    await vi.waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith({
        requestId: 'r4',
        error: 'cancelled',
        cancelled: false,
      }),
    )
  })

  it('reports an AppError by message and marks a cancellation as one', async () => {
    showDownloadDialog.mockImplementation((_list, _ok, fail) =>
      fail(createCancellation({ technicalMessage: 'model download declined' })),
    )
    handler?.({
      requestId: 'r6',
      kind: 'download',
      models: [{ repo_id: 'x' }],
    })
    await vi.waitFor(() =>
      expect(respondMock).toHaveBeenCalledWith({
        requestId: 'r6',
        error: 'model download declined',
        cancelled: true,
      }),
    )
  })

  it('returns confirmed/remember from the VRAM warning dialog', async () => {
    const pending = new Promise<void>((resolve) => {
      respondMock.mockImplementation(async () => resolve())
    })
    handler?.({
      requestId: 'r5',
      kind: 'vram-warning',
      presetName: 'LTX-Video',
      message: 'needs lots of VRAM',
    })
    await vi.waitFor(() => expect(showWarningDialog).toHaveBeenCalledTimes(1))
    const [, confirmFn] = showWarningDialog.mock.calls[0]
    confirmFn(true)
    await pending
    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'r5',
      result: { confirmed: true, remember: true },
    })
  })
})
