import { beforeEach, describe, expect, it, vi } from 'vitest'

type SpeechCheck = { blocked: false } | { blocked: true; message: string } | { cancelled: true }
const checkSpeechInputIpc = vi.fn(
  async (_requestId: string, _text: string): Promise<SpeechCheck> => ({ blocked: false }),
)
const cancelSpeechInputCheckIpc = vi.fn(async (_requestId: string) => {})

const { checkSpeechInput, resetSpeechInputCacheForTest, SpeechInputBlockedError } =
  await import('@/assets/js/speech/speechInputGuard')

beforeEach(() => {
  resetSpeechInputCacheForTest()
  checkSpeechInputIpc.mockReset()
  checkSpeechInputIpc.mockResolvedValue({ blocked: false })
  cancelSpeechInputCheckIpc.mockClear()
  vi.stubGlobal('window', {
    electronAPI: {
      chat: {
        checkSpeechInput: checkSpeechInputIpc,
        cancelSpeechInputCheck: cancelSpeechInputCheckIpc,
      },
    },
  })
})

describe('checkSpeechInput', () => {
  it('asks the guard once for the same passed input (caller, then engine)', async () => {
    await checkSpeechInput(['hello', 'a calm narrator'])
    await checkSpeechInput(['hello', 'a calm narrator'])
    expect(checkSpeechInputIpc).toHaveBeenCalledTimes(1)
    expect(checkSpeechInputIpc).toHaveBeenCalledWith(expect.any(String), 'hello\na calm narrator')
  })

  it('asks again for a different voice description', async () => {
    await checkSpeechInput(['hello', 'a calm narrator'])
    await checkSpeechInput(['hello', 'a whisper'])
    expect(checkSpeechInputIpc).toHaveBeenCalledTimes(2)
  })

  it('never remembers a blocked input', async () => {
    checkSpeechInputIpc.mockResolvedValue({ blocked: true, message: 'Blocked' })
    await expect(checkSpeechInput(['bad'])).rejects.toBeInstanceOf(SpeechInputBlockedError)
    await expect(checkSpeechInput(['bad'])).rejects.toThrow('Blocked')
    expect(checkSpeechInputIpc).toHaveBeenCalledTimes(2)
  })

  it('does not remember a check that was stopped', async () => {
    checkSpeechInputIpc.mockResolvedValueOnce({ cancelled: true })
    await expect(checkSpeechInput(['hello'])).rejects.toMatchObject({ name: 'AbortError' })
    await checkSpeechInput(['hello'])
    expect(checkSpeechInputIpc).toHaveBeenCalledTimes(2)
  })

  it('forgets the oldest passed inputs beyond its limit', async () => {
    for (let i = 0; i < 33; i++) await checkSpeechInput([`line ${i}`])
    checkSpeechInputIpc.mockClear()
    await checkSpeechInput(['line 0'])
    await checkSpeechInput(['line 32'])
    expect(checkSpeechInputIpc).toHaveBeenCalledTimes(1)
    expect(checkSpeechInputIpc).toHaveBeenCalledWith(expect.any(String), 'line 0')
  })
})
