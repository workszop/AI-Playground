import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  aipgFetch: vi.fn(),
  streamPromise: Promise.resolve(),
  resolveStream: () => {},
  stopPromise: Promise.resolve(),
  resolveStop: () => {},
  onData: undefined as ((line: string) => void) | undefined,
}))

vi.mock('@/lib/loopbackAuth', () => ({ aipgFetch: state.aipgFetch }))
vi.mock('@/assets/js/sseProcessor', () => ({
  SSEProcessor: class {
    constructor(_reader: unknown, onData?: (line: string) => void) {
      state.onData = onData
    }

    start() {
      return state.streamPromise
    }
  },
}))

import { runModelDownload } from './modelDownloader'

const MODELS = [{ repo_id: 'owner/model', type: 'llm' }] as DownloadModelParam[]

describe('model download cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.onData = undefined
    state.streamPromise = new Promise<void>((resolve) => {
      state.resolveStream = resolve
    })
    state.stopPromise = new Promise<void>((resolve) => {
      state.resolveStop = resolve
    })
    state.aipgFetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/downloadModel')) {
        return { body: { getReader: () => ({}) } }
      }
      return state.stopPromise
    })
  })

  it('ignores late stream events and waits for the stop request', async () => {
    const controller = new AbortController()
    const onProgress = vi.fn()
    const download = runModelDownload(MODELS, {
      apiHost: 'http://127.0.0.1:1234',
      signal: controller.signal,
      onProgress,
    })

    await vi.waitFor(() =>
      expect(state.aipgFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:1234/api/downloadModel',
        expect.anything(),
      ),
    )
    controller.abort()
    await vi.waitFor(() =>
      expect(state.aipgFetch).toHaveBeenCalledWith('http://127.0.0.1:1234/api/stopDownloadModel'),
    )
    state.onData?.('data: {"type":"download_model_progress","repo_id":"owner/model","percent":90}')
    expect(onProgress).not.toHaveBeenCalled()
    expect(
      await Promise.race([
        download.then(
          () => 'settled',
          () => 'settled',
        ),
        Promise.resolve('pending'),
      ]),
    ).toBe('pending')

    state.resolveStop()
    state.resolveStream()
    await expect(download).resolves.toBeUndefined()
  })

  it('does not stop a download that never started', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runModelDownload(MODELS, {
        apiHost: 'http://127.0.0.1:1234',
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled')
    expect(state.aipgFetch).not.toHaveBeenCalled()
  })
})
