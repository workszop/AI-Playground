import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDialogStore } from '@/assets/js/store/dialogs'

const MODELS = [{ repo_id: 'owner/model', type: 'llm' }] as DownloadModelParam[]

describe('download dialog ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('settles a replaced owner only after its cancellation cleanup', async () => {
    const dialog = useDialogStore()
    let resolveCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    const firstFail = vi.fn()
    const first = dialog.showDownloadDialog(MODELS, undefined, firstFail, { requestId: 'first' })
    dialog.registerDownloadCancel(first, () => cleanup)

    const secondFail = vi.fn()
    const second = dialog.showDownloadDialog(MODELS, undefined, secondFail, { requestId: 'second' })
    expect(first).not.toBe(second)
    expect(firstFail).not.toHaveBeenCalled()
    expect(dialog.currentDownloadSession()).toBe(second)

    resolveCleanup()
    await vi.waitFor(() => expect(firstFail).toHaveBeenCalledTimes(1))
    expect(secondFail).not.toHaveBeenCalled()
    expect(dialog.currentDownloadSession()).toBe(second)
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

  it('holds a replacement download behind the previous cleanup', async () => {
    const dialog = useDialogStore()
    let resolveCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve
    })
    const first = dialog.showDownloadDialog(MODELS, undefined, undefined, { requestId: 'first' })
    dialog.registerDownloadCancel(first, () => cleanup)
    dialog.showDownloadDialog(MODELS, undefined, undefined, { requestId: 'second' })

    const wait = dialog.waitForDownloadCleanup()
    expect(await Promise.race([wait, Promise.resolve('pending')])).toBe('pending')
    resolveCleanup()
    await expect(wait).resolves.toBeUndefined()
  })
})
