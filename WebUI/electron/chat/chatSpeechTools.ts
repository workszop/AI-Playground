import type { ModelMessage } from 'ai'
import { buildTtsAudioFileName } from '@/lib/ttsAudioFileName'
import { saveGeneratedAudioFile } from '../persist/audioFiles'
import { filePartToBase64, findLatestAttachment } from './chatFileParts'
import { trackChatToolActivity, updateChatToolActivity } from './chatToolActivity'
import { askRenderer } from './chatAsk'
import type { ChatAskPhase, SpeechClipPayload, SpeechVoiceSelection } from '@/types/chatRequests'
import { TTS_STOPPED_MESSAGE } from '@/lib/kidsSafeMessages'

/**
 * Main-side bodies for `synthesizeTextToSpeech` and `transcribeAudio`.
 *
 * Everything the tool *is* lives here: the activity, finding the audio the
 * model meant, naming and writing the clip, and the sentence the model reads
 * back. Only the engine call itself crosses to the renderer, where the
 * download prompt and Chromium's audio decoder are (see
 * `@/types/chatRequests`).
 */

export const CHAT_SPEECH_TOOLS = new Set(['synthesizeTextToSpeech', 'transcribeAudio'])

const SPEECH_PHASE_LABELS: Record<ChatAskPhase, string> = {
  checking: 'Checking text…',
  'loading-model': 'Loading voice model…',
  generating: 'Generating audio file…',
}

export type SynthesizeSpeechOutput = {
  ok: boolean
  message: string
  savedFilePath?: string
  speaker?: string
  language?: string
  mode?: 'custom_voice' | 'voice_design' | 'voice_clone'
}

export type TranscribeAudioOutput = {
  ok: boolean
  message: string
  transcript?: string
}

type SynthesizeInput = SpeechVoiceSelection & {
  text?: string
  outputFileName?: string
}

function clipMessage(clip: SpeechClipPayload, savedFilePath: string): string {
  const detail =
    clip.engine === 'qwen3'
      ? `Synthesized ${clip.mode} speech (${clip.language}, ${clip.voice}).`
      : `Synthesized speech with ${clip.engine === 'kokoro' ? 'Kokoro' : 'the external endpoint'} (${clip.voice}).`
  return `${detail} Saved to ${savedFilePath}. The audio player is shown in the chat.`
}

async function synthesize(options: {
  input: unknown
  conversationKey: string
  conversationLabel?: string
  abortSignal?: AbortSignal
}): Promise<SynthesizeSpeechOutput> {
  const args = (options.input ?? {}) as SynthesizeInput
  const text = typeof args.text === 'string' ? args.text : ''
  if (!text.trim()) {
    return { ok: false, message: 'No text to speak.' }
  }
  try {
    return await trackChatToolActivity(
      {
        category: 'tools',
        // Three visible phases: the kids-safe input check, loading the model
        // (slow on the first call, and where the install prompt lands), then
        // writing the audio. The engine reports each switch over progress pings.
        label: SPEECH_PHASE_LABELS.checking,
        conversationKey: options.conversationKey,
      },
      async (activityId) => {
        const clip = await askRenderer<SpeechClipPayload>(
          {
            kind: 'speech-synthesize',
            text,
            voice: {
              speaker: args.speaker,
              language: args.language,
              mode: args.mode,
              instruct: args.instruct,
              voiceName: args.voiceName,
              rememberAsDefault: args.rememberAsDefault,
            },
          },
          {
            onPhase: (phase) =>
              updateChatToolActivity(activityId, { label: SPEECH_PHASE_LABELS[phase] }),
            abortSignal: options.abortSignal,
          },
        )
        const fileName = buildTtsAudioFileName({
          conversationKey: options.conversationKey,
          conversationLabel:
            options.conversationLabel?.trim() || `chat_${options.conversationKey.slice(-8)}`,
          userSlug: args.outputFileName,
        })
        const savedFilePath = await saveGeneratedAudioFile(clip.audioBase64, fileName)
        return {
          ok: true,
          message: clipMessage(clip, savedFilePath),
          savedFilePath,
          speaker: clip.voice,
          ...(clip.engine === 'qwen3' ? { language: clip.language, mode: clip.mode } : {}),
        }
      },
    )
  } catch (error) {
    if (options.abortSignal?.aborted) return { ok: false, message: TTS_STOPPED_MESSAGE }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function transcribeLatestAttachment(options: {
  conversationKey: string
  messages: ModelMessage[] | undefined
  readMediaAsDataUri: (url: string) => Promise<string>
  abortSignal?: AbortSignal
}): Promise<TranscribeAudioOutput> {
  try {
    return await trackChatToolActivity(
      {
        category: 'tools',
        label: 'Transcribing audio…',
        conversationKey: options.conversationKey,
      },
      async () => {
        const audioPart = findLatestAttachment(options.messages, 'audio/')
        if (!audioPart?.data) {
          throw new Error('No audio attachment found in the conversation to transcribe.')
        }
        const audioBase64 = await filePartToBase64(audioPart.data, options.readMediaAsDataUri)
        const { text } = await askRenderer<{ text: string }>(
          {
            kind: 'speech-transcribe',
            audioBase64,
            ...(audioPart.mediaType ? { mediaType: audioPart.mediaType } : {}),
          },
          { abortSignal: options.abortSignal },
        )
        return { ok: true, message: 'Transcribed audio.', transcript: text }
      },
    )
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function executeChatSpeechTool(options: {
  toolName: string
  input: unknown
  conversationKey: string
  conversationLabel?: string
  messages?: ModelMessage[]
  readMediaAsDataUri: (url: string) => Promise<string>
  abortSignal?: AbortSignal
}): Promise<SynthesizeSpeechOutput | TranscribeAudioOutput> {
  if (options.toolName === 'synthesizeTextToSpeech') {
    return await synthesize({
      input: options.input,
      conversationKey: options.conversationKey,
      conversationLabel: options.conversationLabel,
      abortSignal: options.abortSignal,
    })
  }
  return await transcribeLatestAttachment({
    conversationKey: options.conversationKey,
    messages: options.messages,
    readMediaAsDataUri: options.readMediaAsDataUri,
    abortSignal: options.abortSignal,
  })
}
