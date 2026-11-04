import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Engine selection and availability are read at call time, so refs keep them
// mutable per test without re-importing the SUT.
const sttEngine = ref<'whisper' | 'standalone' | 'external'>('whisper')
const sttAvailable = ref(true)
const ttsEngine = ref<'qwen3' | 'kokoro' | 'external'>('qwen3')
const ttsAvailable = ref(true)
const ttsKokoroAvailable = ref(true)
const ttsExternalAvailable = ref(true)
const qwenBackendSetUp = ref(true)
const qwenModelLoaded = ref(false)

const ensureWhisperReadyMock = vi.fn(async () => ({ downloadPrompted: false }))
const ensureStandaloneReadyMock = vi.fn(async () => ({ downloadPrompted: false }))
const resolveTranscriptionMock = vi.fn(
  async (..._args: unknown[]): Promise<{ baseURL: string; model: string; apiKey: string } | null> =>
    null,
)

const ensureSpeechServerRunningMock = vi.fn(async () => {})
const resolveSpeechMock = vi.fn(
  async (
    ..._args: unknown[]
  ): Promise<{
    baseURL: string
    model: string
    voice: string
    apiKey: string
  } | null> => null,
)
const synthesizeToWavMock = vi.fn(async () => ({ audioBase64: 'Tts9', voice: 'af_heart' }))

const qwenIsModelLoadedMock = vi.fn(async () => qwenModelLoaded.value)
const qwenEnsureModelLoadedMock = vi.fn(async () => {})
const qwenSynthesizeMock = vi.fn(async () => ({
  audioBase64: 'QXdlbjM=',
  mediaType: 'audio/x-wav',
  speaker: 'Ryan',
  language: 'English',
  mode: 'custom_voice',
}))
const qwenApplyUserVoicePreferenceMock = vi.fn(async () => {})
const qwenSaveWavToDiskMock = vi.fn(async () => '/audio/clip.wav')
const qwenVoiceDescriptionForMock = vi.fn(
  (_args: { mode?: string; voiceName?: string; instruct?: string }): string | undefined =>
    undefined,
)
type SpeechCheck = { blocked: false } | { blocked: true; message: string } | { cancelled: true }
const checkSpeechInputMock = vi.fn(
  async (_requestId: string, _text: string): Promise<SpeechCheck> => ({ blocked: false }),
)
const cancelSpeechInputCheckMock = vi.fn(async (_requestId: string) => {})

const transcribeAudioBufferMock = vi.fn(async () => 'buffer transcript')
const transcribeAudioBlobMock = vi.fn(async () => 'blob transcript')
const synthesizeSpeechMock = vi.fn(async (..._args: unknown[]) => ({
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: 'audio/wav',
}))
const bytesToBase64Mock = vi.fn(() => 'AQID')
const base64ToBytesMock = vi.fn(() => new Uint8Array([1, 2, 3]))
const bytesToBlobUrlMock = vi.fn(() => 'blob:fake-url')
const errorsReportMock = vi.fn()
const saveGeneratedAudioMock = vi.fn(async () => ({ success: true, filePath: '/audio/clip.wav' }))

vi.mock('@/assets/js/store/speechToText', () => ({
  useSpeechToText: () => ({
    effectiveSttEngine: sttEngine.value,
    available: sttAvailable.value,
    ensureWhisperReady: ensureWhisperReadyMock,
    ensureStandaloneReady: ensureStandaloneReadyMock,
    resolveTranscription: resolveTranscriptionMock,
  }),
}))
vi.mock('@/assets/js/store/textToSpeech', () => ({
  useTextToSpeech: () => ({
    selectedEngine: ttsEngine.value,
    available: ttsAvailable.value,
    isKokoroAvailable: ttsKokoroAvailable.value,
    isExternalAvailable: ttsExternalAvailable.value,
    ensureSpeechServerRunning: ensureSpeechServerRunningMock,
    resolveSpeech: resolveSpeechMock,
    synthesizeToWav: synthesizeToWavMock,
  }),
}))
vi.mock('@/assets/js/store/qwen3TextToSpeech', () => ({
  useQwen3TextToSpeech: () => ({
    isBackendSetUp: () => qwenBackendSetUp.value,
    isModelLoaded: qwenIsModelLoadedMock,
    ensureModelLoaded: qwenEnsureModelLoadedMock,
    synthesize: qwenSynthesizeMock,
    applyUserVoicePreference: qwenApplyUserVoicePreferenceMock,
    saveWavToDisk: qwenSaveWavToDiskMock,
    voiceDescriptionFor: qwenVoiceDescriptionForMock,
  }),
}))
vi.mock('@/lib/transcribe', () => ({
  transcribeAudioBuffer: transcribeAudioBufferMock,
  transcribeAudioBlob: transcribeAudioBlobMock,
}))
vi.mock('@/lib/synthesizeSpeech', () => ({
  synthesizeSpeech: synthesizeSpeechMock,
  bytesToBase64: bytesToBase64Mock,
  bytesToBlobUrl: bytesToBlobUrlMock,
  base64ToBytes: base64ToBytesMock,
}))
vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReportMock }),
}))

// Imported late on purpose: a dynamic import runs in source order, so the
// hoisted factories only execute after the mock consts are initialized.
const {
  NO_TRANSCRIPTION_ENDPOINT,
  isSpeaking,
  pendingVoiceTurn,
  readyTranscriptionForInput,
  saveSpeechClip,
  speak,
  speakRepliesAvailable,
  speakingMessageId,
  stopSpeaking,
  synthesizeClip,
  synthesizeToolAvailable,
  transcribe,
  transcriptionAvailable,
  SpeechInputBlockedError,
} = await import('@/assets/js/speech/speechIO')
const { KIDS_GUARD_UNAVAILABLE_MESSAGE } = await import('@/lib/kidsSafeMessages')
const { resetSpeechInputCacheForTest } = await import('@/assets/js/speech/speechInputGuard')

/** A minimal RIFF/WAVE header so `transcribe` takes the no-re-encode path. */
function wavBlob(): Blob {
  const header = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
  return new Blob([header], { type: 'audio/wav' })
}

class FakeAudio {
  static last: FakeAudio | undefined
  play = vi.fn().mockResolvedValue(undefined)
  pause = vi.fn()
  src = ''
  onended: (() => void) | undefined
  onerror: (() => void) | undefined
  constructor() {
    FakeAudio.last = this
  }
}

describe('speechIO (Speech I/O adapter)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sttEngine.value = 'whisper'
    sttAvailable.value = true
    ttsEngine.value = 'qwen3'
    ttsAvailable.value = true
    ttsKokoroAvailable.value = true
    ttsExternalAvailable.value = true
    qwenBackendSetUp.value = true
    qwenModelLoaded.value = false
    resolveTranscriptionMock.mockResolvedValue({
      baseURL: 'http://localhost:29000/v3',
      model: 'whisper',
      apiKey: '',
    })
    resolveSpeechMock.mockResolvedValue({
      baseURL: 'http://localhost:29000/v3',
      model: 'kokoro',
      voice: 'af_heart',
      apiKey: '',
    })
    resetSpeechInputCacheForTest()
    checkSpeechInputMock.mockReset()
    checkSpeechInputMock.mockResolvedValue({ blocked: false })
    qwenVoiceDescriptionForMock.mockReturnValue(undefined)
    vi.stubGlobal('window', {
      electronAPI: {
        saveGeneratedAudio: saveGeneratedAudioMock,
        chat: {
          checkSpeechInput: checkSpeechInputMock,
          cancelSpeechInputCheck: cancelSpeechInputCheckMock,
        },
      },
    })
    ;(globalThis as Record<string, unknown>).Audio = FakeAudio
    ;(globalThis.URL as typeof globalThis.URL & { revokeObjectURL?: unknown }).revokeObjectURL =
      vi.fn()
    stopSpeaking()
    pendingVoiceTurn.value = false
  })

  describe('STT readiness', () => {
    it('readies the OpenVINO engine interactively and reports its result', async () => {
      ensureWhisperReadyMock.mockResolvedValueOnce({ downloadPrompted: true })
      const ready = await readyTranscriptionForInput()
      expect(ensureWhisperReadyMock).toHaveBeenCalledTimes(1)
      expect(ensureStandaloneReadyMock).not.toHaveBeenCalled()
      expect(ready).toEqual({ downloadPrompted: true })
    })

    it('readies the standalone engine interactively', async () => {
      sttEngine.value = 'standalone'
      await readyTranscriptionForInput()
      expect(ensureStandaloneReadyMock).toHaveBeenCalledTimes(1)
      expect(ensureWhisperReadyMock).not.toHaveBeenCalled()
    })

    it('starts nothing for the external engine', async () => {
      sttEngine.value = 'external'
      const ready = await readyTranscriptionForInput()
      expect(ensureWhisperReadyMock).not.toHaveBeenCalled()
      expect(ensureStandaloneReadyMock).not.toHaveBeenCalled()
      expect(ready).toEqual({ downloadPrompted: false })
    })

    it('exposes STT availability for the mic gate', () => {
      expect(transcriptionAvailable()).toBe(true)
      sttAvailable.value = false
      expect(transcriptionAvailable()).toBe(false)
    })
  })

  describe('transcribe', () => {
    it('sends WAV bytes straight to the resolved endpoint', async () => {
      const { text } = await transcribe({ audio: wavBlob() })
      expect(text).toBe('buffer transcript')
      expect(transcribeAudioBufferMock).toHaveBeenCalledTimes(1)
      expect(transcribeAudioBlobMock).not.toHaveBeenCalled()
      expect(resolveTranscriptionMock).toHaveBeenCalledTimes(1)
    })

    it('converts non-WAV audio before transcribing', async () => {
      const { text } = await transcribe({
        audio: new Blob(['not a wav'], { type: 'audio/webm' }),
      })
      expect(text).toBe('blob transcript')
      expect(transcribeAudioBlobMock).toHaveBeenCalledTimes(1)
      expect(transcribeAudioBufferMock).not.toHaveBeenCalled()
    })

    it('throws the shared no-endpoint error when nothing can serve', async () => {
      resolveTranscriptionMock.mockResolvedValueOnce(null)
      await expect(transcribe({ audio: wavBlob() })).rejects.toThrow(NO_TRANSCRIPTION_ENDPOINT)
      expect(transcribeAudioBufferMock).not.toHaveBeenCalled()
    })
  })

  describe('synthesizeClip (Qwen3)', () => {
    it('loads the model when not resident, then synthesizes with the voice request', async () => {
      const phases: string[] = []
      const clip = await synthesizeClip({
        text: 'hello',
        voice: {
          speaker: 'Ryan',
          language: 'English',
          mode: 'custom_voice',
          instruct: 'calm',
        },
        onPhase: (phase) => phases.push(phase),
      })
      expect(phases).toEqual(['checking', 'loading-model', 'generating'])
      expect(qwenIsModelLoadedMock).toHaveBeenCalledWith('custom_voice')
      expect(qwenEnsureModelLoadedMock).toHaveBeenCalledWith('custom_voice')
      expect(qwenSynthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'hello',
          speaker: 'Ryan',
          language: 'English',
          mode: 'custom_voice',
          instruct: 'calm',
        }),
      )
      expect(clip).toMatchObject({
        audioBase64: 'QXdlbjM=',
        mediaType: 'audio/x-wav',
        voice: 'Ryan',
        engine: 'qwen3',
        mode: 'custom_voice',
        language: 'English',
      })
      expect(qwenApplyUserVoicePreferenceMock).not.toHaveBeenCalled()
    })

    it('resolves a saved voice to the voice_design load mode', async () => {
      await synthesizeClip({ text: 'hi', voice: { voiceName: 'Tammy' } })
      expect(qwenIsModelLoadedMock).toHaveBeenCalledWith('voice_design')
      expect(qwenSynthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({ voiceName: 'Tammy' }),
      )
    })

    it('skips the model load when the engine reports it resident', async () => {
      qwenModelLoaded.value = true
      await synthesizeClip({ text: 'hello' })
      expect(qwenEnsureModelLoadedMock).not.toHaveBeenCalled()
      expect(qwenSynthesizeMock).toHaveBeenCalledTimes(1)
    })

    it('persists the default voice only when asked', async () => {
      await synthesizeClip({
        text: 'hello',
        voice: {
          speaker: 'Vivian',
          language: 'German',
          mode: 'custom_voice',
          rememberAsDefault: true,
        },
      })
      expect(qwenApplyUserVoicePreferenceMock).toHaveBeenCalledWith({
        speaker: 'Vivian',
        language: 'German',
        mode: 'custom_voice',
      })
    })
  })

  describe('synthesizeClip kids-safe input check', () => {
    it('judges the words and the voice description before synthesizing', async () => {
      qwenVoiceDescriptionForMock.mockReturnValue('a calm narrator')
      await synthesizeClip({ text: 'hello', voice: { voiceName: 'Tammy' } })
      expect(qwenVoiceDescriptionForMock).toHaveBeenCalledWith({
        mode: undefined,
        voiceName: 'Tammy',
        instruct: undefined,
      })
      expect(checkSpeechInputMock).toHaveBeenCalledWith(
        expect.any(String),
        'hello\na calm narrator',
      )
      expect(qwenSynthesizeMock).toHaveBeenCalled()
    })

    it('makes no audio and throws the guard message when blocked', async () => {
      checkSpeechInputMock.mockResolvedValue({ blocked: true, message: 'Blocked' })
      const attempt = synthesizeClip({ text: 'bad words' })
      await expect(attempt).rejects.toBeInstanceOf(SpeechInputBlockedError)
      await expect(attempt).rejects.toThrow('Blocked')
      expect(qwenEnsureModelLoadedMock).not.toHaveBeenCalled()
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('checks Kokoro / external input too, without a voice description', async () => {
      ttsEngine.value = 'kokoro'
      checkSpeechInputMock.mockResolvedValue({ blocked: true, message: 'Blocked' })
      await expect(synthesizeClip({ text: 'bad words' })).rejects.toThrow('Blocked')
      expect(checkSpeechInputMock).toHaveBeenCalledWith(expect.any(String), 'bad words')
      expect(qwenVoiceDescriptionForMock).not.toHaveBeenCalled()
      expect(synthesizeToWavMock).not.toHaveBeenCalled()
    })

    it('blocks when the guard cannot be asked (fail closed)', async () => {
      checkSpeechInputMock.mockRejectedValue(new Error('ipc gone'))
      await expect(synthesizeClip({ text: 'hello' })).rejects.toThrow(
        KIDS_GUARD_UNAVAILABLE_MESSAGE,
      )
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('cancels the check on Stop and makes no audio', async () => {
      let finish!: (result: SpeechCheck) => void
      checkSpeechInputMock.mockImplementation(
        () => new Promise<SpeechCheck>((resolve) => (finish = resolve)),
      )
      const controller = new AbortController()
      const attempt = synthesizeClip({ text: 'hello', signal: controller.signal })
      await vi.waitFor(() => expect(checkSpeechInputMock).toHaveBeenCalled())
      controller.abort()
      const requestId = checkSpeechInputMock.mock.calls[0][0]
      expect(cancelSpeechInputCheckMock).toHaveBeenCalledWith(requestId)
      finish({ cancelled: true })
      await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('makes no audio when stopped while a safe verdict was on its way', async () => {
      let finish!: (result: SpeechCheck) => void
      checkSpeechInputMock.mockImplementation(
        () => new Promise<SpeechCheck>((resolve) => (finish = resolve)),
      )
      const controller = new AbortController()
      const attempt = synthesizeClip({ text: 'hello', signal: controller.signal })
      await vi.waitFor(() => expect(checkSpeechInputMock).toHaveBeenCalled())
      controller.abort()
      finish({ blocked: false })
      await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })
  })

  describe('synthesizeClip Stop after the check', () => {
    it('loads no model and makes no audio when stopped after the check', async () => {
      const controller = new AbortController()
      checkSpeechInputMock.mockImplementation(async () => {
        controller.abort()
        return { blocked: false }
      })
      await expect(
        synthesizeClip({ text: 'hello', signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(qwenIsModelLoadedMock).not.toHaveBeenCalled()
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('makes no audio when stopped while the voice model loads', async () => {
      const controller = new AbortController()
      qwenEnsureModelLoadedMock.mockImplementationOnce(async () => controller.abort())
      await expect(
        synthesizeClip({ text: 'hello', signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(qwenEnsureModelLoadedMock).toHaveBeenCalled()
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })

    it('hands the Stop signal to the Qwen3 engine', async () => {
      const controller = new AbortController()
      await synthesizeClip({ text: 'hello', signal: controller.signal })
      expect(qwenSynthesizeMock).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      )
    })
  })

  describe('synthesizeClip (Kokoro / external)', () => {
    it('synthesizes interactively through the selected engine', async () => {
      ttsEngine.value = 'kokoro'
      const phases: string[] = []
      const clip = await synthesizeClip({ text: 'hello', onPhase: (p) => phases.push(p) })
      expect(phases).toEqual(['checking', 'generating'])
      expect(synthesizeToWavMock).toHaveBeenCalledWith('hello', undefined)
      expect(clip).toMatchObject({
        audioBase64: 'Tts9',
        mediaType: 'audio/wav',
        voice: 'af_heart',
        engine: 'kokoro',
      })
      expect(qwenSynthesizeMock).not.toHaveBeenCalled()
    })
  })

  describe('desktop playback (speak)', () => {
    it('synthesizes and plays the trimmed text, tracking the message', async () => {
      await speak({ text: '  hello there  ', messageId: 'msg-1' })
      expect(synthesizeSpeechMock).toHaveBeenCalledWith(
        'hello there',
        expect.objectContaining({ model: 'kokoro' }),
      )
      expect(bytesToBase64Mock).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
      expect(bytesToBlobUrlMock).toHaveBeenCalledWith(expect.any(Uint8Array), 'audio/wav')
      expect(isSpeaking.value).toBe(true)
      expect(speakingMessageId.value).toBe('msg-1')
      expect(FakeAudio.last?.play).toHaveBeenCalledTimes(1)
      FakeAudio.last?.onended?.()
      expect(isSpeaking.value).toBe(false)
      expect(speakingMessageId.value).toBe(null)
    })

    it('reports instead of playing when no endpoint resolves', async () => {
      resolveSpeechMock.mockResolvedValueOnce(null)
      await speak({ text: 'hello' })
      expect(errorsReportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'inference/tts-unavailable',
          userMessage: 'Text To Speech is not available (no OVMS server or fallback configured)',
        }),
      )
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
      expect(isSpeaking.value).toBe(false)
    })

    it('reports instead of playing when no playback engine is configured', async () => {
      ttsAvailable.value = false
      await speak({ text: 'hello' })
      expect(errorsReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'inference/tts-unavailable' }),
      )
      expect(ensureSpeechServerRunningMock).not.toHaveBeenCalled()
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
    })

    it('reports synthesis failures through the error sink and stops playback', async () => {
      synthesizeSpeechMock.mockRejectedValueOnce(new Error('server down'))
      await speak({ text: 'hello', messageId: 'msg-9' })
      expect(errorsReportMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ code: 'inference/tts-failed', surface: 'toast' }),
      )
      expect(isSpeaking.value).toBe(false)
      expect(speakingMessageId.value).toBe(null)
    })

    it('skips synthesis for empty text', async () => {
      await speak({ text: '   ' })
      expect(synthesizeSpeechMock).not.toHaveBeenCalled()
      expect(ensureSpeechServerRunningMock).not.toHaveBeenCalled()
    })

    it('reports reply-playback availability from the engine config', () => {
      expect(speakRepliesAvailable()).toBe(true)
      ttsAvailable.value = false
      expect(speakRepliesAvailable()).toBe(false)
    })
  })

  describe('tool gating and clip saving', () => {
    it('gates the synthesis tool on the selected engine being usable', () => {
      expect(synthesizeToolAvailable()).toBe(true)
      ttsEngine.value = 'kokoro'
      expect(synthesizeToolAvailable()).toBe(true)
      ttsKokoroAvailable.value = false
      expect(synthesizeToolAvailable()).toBe(false)
      ttsEngine.value = 'external'
      ttsExternalAvailable.value = false
      expect(synthesizeToolAvailable()).toBe(false)
    })

    it('saves a clip through the engine-agnostic persistence IPC, not the Qwen3 store', async () => {
      const path = await saveSpeechClip('QXdlbjM=', 'clip.wav')
      expect(saveGeneratedAudioMock).toHaveBeenCalledWith('QXdlbjM=', 'clip.wav', undefined)
      expect(path).toBe('/audio/clip.wav')
      expect(qwenSaveWavToDiskMock).not.toHaveBeenCalled()
    })
  })
})
