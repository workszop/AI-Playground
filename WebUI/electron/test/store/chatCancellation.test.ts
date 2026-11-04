import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import type { UIMessageChunk } from 'ai'

const state = vi.hoisted(() => ({
  conversations: {} as Record<string, unknown>,
  streams: new Map<string, ReadableStreamDefaultController<UIMessageChunk>>(),
  report: vi.fn((error: unknown) => error),
  ttsPreset: false,
  synthesizeClip: vi.fn(
    async (_req: { text: string; signal?: AbortSignal }) =>
      ({ engine: 'external', audioBase64: '', voice: 'test' }) as const,
  ),
  SpeechInputBlockedError: class SpeechInputBlockedError extends Error {},
}))

vi.mock('@/assets/js/store/conversations', () => ({
  useConversations: () => state.conversations,
}))
vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    backend: 'cloud',
    activeModel: 'test-model',
    get activePreset() {
      return state.ttsPreset ? { ttsPreset: true } : undefined
    },
    systemPrompt: '',
    modelSupportsToolCalling: false,
    ensureGlobalsMatchConversation: vi.fn(),
    stampMetaForConversation: vi.fn(),
    checkModelAvailability: async () => {},
    completeBackendPreparation: vi.fn(),
  }),
}))
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: state.report }) }))
vi.mock('@/assets/js/store/activities', () => ({
  useActivities: () => ({
    begin: () => 'activity',
    update: vi.fn(),
    end: vi.fn(),
    endScope: vi.fn(),
    track: (_options: unknown, run: () => unknown) => run(),
  }),
}))
vi.mock('@/assets/js/store/confirmations', () => ({
  useConfirmations: () => ({ cancelForConversation: vi.fn() }),
}))
vi.mock('@/assets/js/store/i18n', () => ({ useI18N: () => ({ state: {}, langName: 'English' }) }))
vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))
vi.mock('@/assets/js/store/computeMetrics', () => ({
  useComputeMetrics: () => ({ beginTurn: vi.fn(), endTurn: vi.fn() }),
}))
vi.mock('@/assets/js/demoAwareStorage', () => ({ demoAwareStorage: {} }))
vi.mock('@/assets/js/tools/tools', () => ({ aipgTools: {} }))
vi.mock('@/assets/js/tools/comfyUi', () => ({
  getAvailableWorkflows: () => [],
  createToolRepairData: vi.fn(),
}))
vi.mock('@/assets/js/tools/comfyUiImageEdit', () => ({
  getAvailableEditWorkflows: () => [],
  createEditToolRepairData: vi.fn(),
}))
vi.mock('@/assets/js/speech/speechIO', () => ({
  readyTranscriptionForInput: vi.fn(),
  synthesizeClip: state.synthesizeClip,
  SpeechInputBlockedError: state.SpeechInputBlockedError,
  synthesizeToolAvailable: () => false,
  saveSpeechClip: async () => '/tmp/speech.wav',
  transcribe: vi.fn(),
  transcriptionAvailable: () => false,
}))
vi.mock('@/assets/js/toast', () => ({ warning: vi.fn() }))
vi.mock('@/lib/chatModel', () => ({ buildChatModelConfig: () => ({ backend: 'cloud' }) }))
vi.mock('@/lib/chatRagRequest', () => ({ buildChatRagRequest: () => undefined }))
vi.mock('@/lib/kernelChatTransport', () => ({
  createKernelChatTransport: () => ({
    sendMessages: async ({ chatId, abortSignal }: { chatId: string; abortSignal: AbortSignal }) =>
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          state.streams.set(chatId, controller)
          controller.enqueue({ type: 'start', messageId: `${chatId}-assistant` })
          abortSignal.addEventListener('abort', () => controller.close(), { once: true })
        },
      }),
  }),
}))

const { useOpenAiCompatibleChat } = await import('@/assets/js/store/openAiCompatibleChat')

describe('conversation-scoped chat cancellation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    state.streams.clear()
    state.report.mockClear()
    state.ttsPreset = false
    state.synthesizeClip.mockReset()
    state.synthesizeClip.mockResolvedValue({ engine: 'external', audioBase64: '', voice: 'test' })
    const conversationList: Record<string, unknown[]> = { local: [], remote: [] }
    state.conversations = reactive({
      activeKey: 'local',
      conversationList,
      ensureConversationBucket: (key: string) => (conversationList[key] ??= []),
      getThreadMeta: () => null,
      getThreadRagHashes: () => [],
      applyConversationMessages: vi.fn(),
      updateConversation: vi.fn(),
    })
    vi.stubGlobal('window', {
      electronAPI: {
        getKernelSnapshot: async () => ({ state: { chatTurns: [] } }),
      },
    })
  })

  it('reports a remote failure after the local conversation is stopped', async () => {
    const chat = useOpenAiCompatibleChat()
    const local = chat.generate('local question')
    const remote = chat.generate('remote question', { conversationKey: 'remote' })
    await vi.waitFor(() => expect(state.streams.size).toBe(2))

    await chat.stop()
    const failure = new Error('Remote backend failed')
    state.streams.get('remote')!.error(failure)
    await Promise.all([local, remote])

    expect(chat.consumeTurnError('remote')).toBe(failure)
    expect(chat.consumeTurnError('local')).toBeUndefined()
    expect(state.report).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ surface: 'silent', context: { conversationKey: 'remote' } }),
    )
  })

  it('keeps another running conversation busy when switching away from a stopped one', async () => {
    const chat = useOpenAiCompatibleChat()
    const local = chat.generate('local question')
    const remote = chat.generate('remote question', { conversationKey: 'remote' })
    await vi.waitFor(() => expect(state.streams.size).toBe(2))

    await chat.stop()
    expect(chat.processing).toBe(false)
    state.conversations.activeKey = 'remote'
    await nextTick()
    const remoteBusy = chat.processing
    state.streams.get('remote')!.close()
    await Promise.all([local, remote])

    expect(remoteBusy).toBe(true)
  })

  it('clears a stopped prompt already in the history and reports a subsequent failure', async () => {
    const chat = useOpenAiCompatibleChat()
    const first = chat.generate('stopped question')
    await vi.waitFor(() => expect(state.streams.has('local')).toBe(true))
    await chat.stop()
    await first
    expect(chat.messageInput).toBe('')

    state.streams.delete('local')
    const retry = chat.generate('next question')
    await vi.waitFor(() => expect(state.streams.has('local')).toBe(true))
    const failure = new Error('Retry failed')
    state.streams.get('local')!.error(failure)
    await retry
    expect(chat.consumeTurnError('local')).toBe(failure)
  })

  it('can regenerate speech after stopping without breaking cancellation state', async () => {
    state.ttsPreset = true
    const history = state.conversations.conversationList as Record<string, unknown[]>
    history.local = [
      { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Read this aloud' }] },
      { id: 'audio', role: 'assistant', parts: [] },
    ]
    const chat = useOpenAiCompatibleChat()
    await chat.stop()
    await chat.regenerate('audio')
    expect(chat.processing).toBe(false)
    expect(chat.getMessagesForKey('local')).toHaveLength(2)
    expect(chat.getMessagesForKey('local')?.[1].parts[0]).toMatchObject({
      type: 'tool-synthesizeTextToSpeech',
      output: { ok: true },
    })
  })

  it('passes a Stop signal to the speech boundary, which runs the kids-safe check', async () => {
    state.ttsPreset = true
    const chat = useOpenAiCompatibleChat()
    await chat.generate('Read this aloud')
    expect(state.synthesizeClip).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Read this aloud', signal: expect.any(AbortSignal) }),
    )
    expect(chat.getMessagesForKey('local')?.[1].parts[0]).toMatchObject({ output: { ok: true } })
  })

  it('shows the blocked message without a toast when the guard blocks the text', async () => {
    state.ttsPreset = true
    state.synthesizeClip.mockRejectedValue(
      new state.SpeechInputBlockedError('Blocked by the guard'),
    )
    const chat = useOpenAiCompatibleChat()
    await chat.generate('something unsafe')
    expect(state.report).not.toHaveBeenCalled()
    const messages = chat.getMessagesForKey('local')
    expect(messages).toHaveLength(2)
    expect(messages?.[1].parts[0]).toMatchObject({
      type: 'tool-synthesizeTextToSpeech',
      output: { ok: false, message: 'Blocked by the guard', savedFilePath: '' },
    })
  })

  it('records a stopped turn, not audio, when Stop is pressed during the check', async () => {
    state.ttsPreset = true
    state.synthesizeClip.mockImplementation(
      (req) =>
        new Promise((_resolve, reject) =>
          req.signal?.addEventListener('abort', () =>
            reject(new DOMException('stopped', 'AbortError')),
          ),
        ),
    )
    const chat = useOpenAiCompatibleChat()
    const turn = chat.generate('Read this aloud')
    await vi.waitFor(() => expect(state.synthesizeClip).toHaveBeenCalled())
    await chat.stop()
    await turn
    expect(state.report).not.toHaveBeenCalled()
    expect(chat.getMessagesForKey('local')?.[1].parts[0]).toMatchObject({
      output: { ok: false, message: 'Text to Speech was stopped.' },
    })
  })

  it('drops a clip that finished after Stop', async () => {
    state.ttsPreset = true
    let finish!: () => void
    state.synthesizeClip.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ engine: 'external', audioBase64: '', voice: 'test' })
        }),
    )
    const chat = useOpenAiCompatibleChat()
    const turn = chat.generate('Read this aloud')
    await vi.waitFor(() => expect(state.synthesizeClip).toHaveBeenCalled())
    await chat.stop()
    finish()
    await turn
    expect(chat.getMessagesForKey('local')?.[1].parts[0]).toMatchObject({
      output: { ok: false, message: 'Text to Speech was stopped.', savedFilePath: '' },
    })
  })

  it('checks the text again when speech is regenerated', async () => {
    state.ttsPreset = true
    state.synthesizeClip.mockRejectedValue(
      new state.SpeechInputBlockedError('Blocked by the guard'),
    )
    const history = state.conversations.conversationList as Record<string, unknown[]>
    history.local = [
      { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Read this aloud' }] },
      { id: 'audio', role: 'assistant', parts: [] },
    ]
    const chat = useOpenAiCompatibleChat()
    await chat.regenerate('audio')
    expect(state.synthesizeClip).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Read this aloud' }),
    )
    expect(chat.getMessagesForKey('local')?.[1].parts[0]).toMatchObject({
      output: { ok: false, message: 'Blocked by the guard' },
    })
  })
})
