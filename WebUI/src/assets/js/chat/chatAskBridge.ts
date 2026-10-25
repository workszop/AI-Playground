import type { ChatAnswerPayload, ChatAskPayload, SpeechClipPayload } from '@/types/chatRequests'
import { readyTranscriptionForInput, synthesizeClip, transcribe } from '../speech/speechIO'

/**
 * Renderer half of the chat tools' question channel.
 *
 * The tool bodies run in main; what is answered here is the part that is
 * genuinely this window's — the speech engine seam (download prompt included),
 * and Chromium's audio decoder.
 */

function respond(payload: ChatAnswerPayload): void {
  void window.electronAPI.chat.answer(payload)
}

function base64ToBlob(base64: string, mediaType?: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], mediaType ? { type: mediaType } : undefined)
}

async function handleRequest(request: ChatAskPayload): Promise<void> {
  try {
    switch (request.kind) {
      case 'speech-synthesize': {
        const clip = await synthesizeClip({
          text: request.text,
          voice: request.voice,
          onPhase: (phase) => respond({ requestId: request.requestId, progress: true, phase }),
        })
        respond({ requestId: request.requestId, result: clip satisfies SpeechClipPayload })
        break
      }
      case 'speech-transcribe': {
        // Already-captured audio: a prompted model download lands before the
        // transcription, so `downloadPrompted` can be ignored (see SttReadyResult).
        await readyTranscriptionForInput()
        const result = await transcribe({
          audio: base64ToBlob(request.audioBase64, request.mediaType),
        })
        respond({ requestId: request.requestId, result })
        break
      }
    }
  } catch (error) {
    respond({
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

let started = false

/** Starts listening for main's chat-tool questions. Call once from the entry. */
export function startChatAskBridge(): void {
  if (started) return
  started = true
  window.electronAPI.chat.onAsk((payload) => {
    void handleRequest(payload)
  })
}
