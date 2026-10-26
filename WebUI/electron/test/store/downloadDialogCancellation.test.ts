import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDialogStore } from '@/assets/js/store/dialogs'

const MODELS = [{ repo_id: 'owner/model', type: 'llm' }] as DownloadModelParam[]

describe('download dialog ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('replaces a prompt that has not started downloading', async () => {
    const dialog = useDialogStore()
    const firstFail = vi.fn()
    const first = dialog.showDownloadDialog(MODELS, undefined, firstFail, { requestId: 'first' })

    const secondFail = vi.fn()
    const second = dialog.showDownloadDialog(MODELS, undefined, secondFail, { requestId: 'second' })
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)
    await vi.waitFor(() => expect(firstFail).toHaveBeenCalledTimes(1))
    expect(secondFail).not.toHaveBeenCalled()
    expect(dialog.currentDownloadSession()).toBe(second)
  })

  it('refuses a new prompt while a download is in progress', () => {
    const dialog = useDialogStore()
    const firstFail = vi.fn()
    const first = dialog.showDownloadDialog(MODELS, undefined, firstFail, { requestId: 'first' })
    const cancel = vi.fn()
    dialog.registerDownloadCancel(first!, cancel)

    const secondFail = vi.fn()
    const second = dialog.showDownloadDialog(MODELS, undefined, secondFail, { requestId: 'second' })
    expect(second).toBeNull()
    expect(secondFail).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(firstFail).not.toHaveBeenCalled()
    expect(dialog.currentDownloadSession()).toBe(first)
  })

  it('cancels an old request by id without touching its replacement', async () => {
    const dialog = useDialogStore()
    const firstFail = vi.fn()
    dialog.showDownloadDialog(MODELS, undefined, firstFail, { requestId: 'first' })
    const secondFail = vi.fn()
    const second = dialog.showDownloadDialog(MODELS, undefined, secondFail, { requestId: 'second' })

    dialog.cancelDownloadDialog('first')
    await vi.waitFor(() => expect(firstFail).toHaveBeenCalledTimes(1))
    expect(secondFail).not.toHaveBeenCalled()
    expect(dialog.currentDownloadSession()).toBe(second)
  })

  it('holds a replacement download behind a cancelled transfer', async () => {
    const dialog = useDialogStore()
    let resolveCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    const first = dialog.showDownloadDialog(MODELS, undefined, undefined, { requestId: 'first' })
    dialog.registerDownloadCancel(first!, () => cleanup)
    dialog.cancelDownloadDialog('first')
    const second = dialog.showDownloadDialog(MODELS, undefined, undefined, { requestId: 'second' })
    expect(second).not.toBeNull()

    const wait = dialog.waitForDownloadCleanup()
    expect(await Promise.race([wait, Promise.resolve('pending')])).toBe('pending')
    resolveCleanup()
    await expect(wait).resolves.toBeUndefined()
  })
})
