import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Kids-safe build: the Qwen3 engine checks its own input, so no caller (the TTS
// preset, the chat tool, Save & preview) can make audio without the guard.

const checkSpeechInputMock = vi.fn(
  async (_parts: (string | undefined)[], _signal?: AbortSignal) => {},
)
vi.mock('@/assets/js/speech/speechInputGuard', () => ({
  checkSpeechInput: checkSpeechInputMock,
  throwIfStopped: (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('stopped', 'AbortError')
  },
}))

const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
  Response.json({
    code: 0,
    data: {
      audioBase64: 'QQ==',
      mediaType: 'audio/wav',
      speaker: 'Ryan',
      language: 'English',
      mode: 'custom_voice',
    },
  }),
)
vi.mock('@/lib/loopbackAuth', () => ({ qwen3TtsFetch: fetchMock }))

const getMissingQwenTtsModels = vi.fn(async (_repos: string[]) => [] as string[])
vi.mock('@/assets/js/store/models', () => ({ useModels: () => ({ getMissingQwenTtsModels }) }))
vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => ({
    info: [
      {
        serviceName: 'qwen3-tts-backend',
        isSetUp: true,
        status: 'running',
        baseUrl: 'http://127.0.0.1:5005',
      },
    ],
    startService: vi.fn(),
  }),
}))
vi.mock('@/assets/js/permissions/permissions', () => ({ requestDownload: vi.fn() }))
vi.mock('@/assets/js/toast', () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/fileBackedPreferences', () => ({
  makeFileBackedPreference: () => ({ init: async () => {} }),
}))

const { useQwen3TextToSpeech } = await import('@/assets/js/store/qwen3TextToSpeech')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  checkSpeechInputMock.mockResolvedValue(undefined)
})

describe('Qwen3 synthesize kids-safe input check', () => {
  it('judges the words and the voice description before fetching a model or audio', async () => {
    const qwen3 = useQwen3TextToSpeech()
    const order: string[] = []
    checkSpeechInputMock.mockImplementation(async () => void order.push('check'))
    getMissingQwenTtsModels.mockImplementation(async () => (order.push('models'), []))

    await qwen3.synthesize({ text: 'hello', mode: 'voice_design', instruct: 'a calm narrator' })

    expect(checkSpeechInputMock).toHaveBeenCalledWith(['hello', 'a calm narrator'], undefined)
    expect(order).toEqual(['check', 'models'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes no audio and fetches no model when blocked', async () => {
    const qwen3 = useQwen3TextToSpeech()
    checkSpeechInputMock.mockRejectedValue(new Error('Blocked'))

    await expect(qwen3.synthesize({ text: 'bad words' })).rejects.toThrow('Blocked')

    expect(getMissingQwenTtsModels).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes no audio when stopped after the check', async () => {
    const qwen3 = useQwen3TextToSpeech()
    const controller = new AbortController()
    getMissingQwenTtsModels.mockImplementation(async () => (controller.abort(), []))

    await expect(
      qwen3.synthesize({ text: 'hello', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hands the Stop signal to the engine request', async () => {
    const qwen3 = useQwen3TextToSpeech()
    const controller = new AbortController()

    await qwen3.synthesize({ text: 'hello', signal: controller.signal })

    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal)
  })
})
