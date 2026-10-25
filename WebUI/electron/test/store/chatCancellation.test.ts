import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, reactive } from 'vue'
import type { UIMessageChunk } from 'ai'

const state = vi.hoisted(() => ({
  conversations: {} as Record<string, unknown>,
  streams: new Map<string, ReadableStreamDefaultController<UIMessageChunk>>(),
  report: vi.fn((error: unknown) => error),
  ttsPreset: false,
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
  synthesizeClip: async () => ({ engine: 'external', audioBase64: '', voice: 'test' }),
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
      electronAPI: { getKernelSnapshot: async () => ({ state: { chatTurns: [] } }) },
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

  it('keeps the stopped prompt available for retry and reports a subsequent failure', async () => {
    const chat = useOpenAiCompatibleChat()
    const first = chat.generate('keep this question')
    await vi.waitFor(() => expect(state.streams.has('local')).toBe(true))
    await chat.stop()
    await first
    expect(chat.messageInput).toBe('keep this question')

    state.streams.delete('local')
    const retry = chat.generate(chat.messageInput)
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
})
