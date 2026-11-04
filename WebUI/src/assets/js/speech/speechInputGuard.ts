import { KIDS_GUARD_UNAVAILABLE_MESSAGE, TTS_STOPPED_MESSAGE } from '@/lib/kidsSafeMessages'

/**
 * Kids-safe check of speech input, shared by every engine entry point. The
 * engines (`qwen3TextToSpeech.synthesize`, `textToSpeech.synthesizeToWav`) call
 * it themselves, so no caller can make audio without it; callers that load
 * models first call it earlier too, and the engine's own call then reuses the
 * verdict instead of asking the guard twice.
 */

/** Thrown when the kids-safe guard blocks speech input; `message` is what to show. */
export class SpeechInputBlockedError extends Error {}

/** Exact inputs the guard already passed, so the engine's own check does not wait twice. */
const PASSED_CACHE_LIMIT = 32
const passedInputs = new Set<string>()

export function speechStoppedError(): DOMException {
  return new DOMException(TTS_STOPPED_MESSAGE, 'AbortError')
}

/** Throws the Stop error when `signal` has fired, so no further step runs. */
export function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw speechStoppedError()
}

/**
 * Judges the words and the voice description before any audio is made. Throws
 * {@link SpeechInputBlockedError} when blocked or when the guard cannot be asked
 * (fail closed), and the Stop error when `signal` stops it.
 */
export async function checkSpeechInput(
  parts: (string | undefined)[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfStopped(signal)
  const text = parts.filter((part) => part?.trim()).join('\n')
  if (passedInputs.has(text)) return
  const requestId = crypto.randomUUID()
  const cancel = () => void window.electronAPI.chat.cancelSpeechInputCheck(requestId)
  signal?.addEventListener('abort', cancel, { once: true })
  let result: Awaited<ReturnType<typeof window.electronAPI.chat.checkSpeechInput>>
  try {
    result = await window.electronAPI.chat.checkSpeechInput(requestId, text)
  } catch {
    throwIfStopped(signal)
    throw new SpeechInputBlockedError(KIDS_GUARD_UNAVAILABLE_MESSAGE)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
  if ('cancelled' in result) throw speechStoppedError()
  throwIfStopped(signal)
  if (result.blocked) throw new SpeechInputBlockedError(result.message)
  passedInputs.add(text)
  if (passedInputs.size > PASSED_CACHE_LIMIT) {
    passedInputs.delete(passedInputs.values().next().value as string)
  }
}

export function resetSpeechInputCacheForTest(): void {
  passedInputs.clear()
}
