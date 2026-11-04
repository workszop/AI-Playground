/**
 * Kids-safe check of speech input: the words to be spoken and the voice
 * description, judged before any audio is made. The renderer owns synthesis, so
 * it asks over IPC per request and may cancel a check it no longer needs (Stop).
 */
import { appLoggerInstance } from '../observability/logger'
import { blockedMessageFor, checkKidsPrompt, isBlocked, type KidsGuardVerdict } from './kidsGuard'

const appLogger = appLoggerInstance

export type GuardUiVerdict = { blocked: false } | { blocked: true; message: string }
export type SpeechInputCheckResult = GuardUiVerdict | { cancelled: true }

function toUiVerdict(verdict: KidsGuardVerdict): GuardUiVerdict {
  return isBlocked(verdict)
    ? { blocked: true, message: blockedMessageFor(verdict) }
    : { blocked: false }
}

/** A guard verdict as the UI shows it: blocked with its message, or allowed. */
export async function guardVerdictForUi(
  text: string,
  signal?: AbortSignal,
): Promise<GuardUiVerdict> {
  return toUiVerdict(await checkKidsPrompt(text, signal))
}

const runningChecks = new Map<string, AbortController>()

/** Judges speech input for one request; fails closed, and reports a cancelled check as such. */
export async function checkSpeechInput(
  requestId: string,
  text: string,
): Promise<SpeechInputCheckResult> {
  runningChecks.get(requestId)?.abort()
  const controller = new AbortController()
  runningChecks.set(requestId, controller)
  try {
    const verdict = await checkKidsPrompt(text, controller.signal)
    if (controller.signal.aborted) return { cancelled: true }
    if (isBlocked(verdict)) {
      // The level and detail (e.g. `blocklist`) say why; the text itself is never logged.
      const why = verdict.detail ? `${verdict.level}, ${verdict.detail}` : verdict.level
      appLogger.info(`Kids guard blocked speech input (${why})`, 'kids-guard')
    }
    return toUiVerdict(verdict)
  } catch (error) {
    if (controller.signal.aborted) return { cancelled: true }
    appLogger.warn(`Speech input check failed: ${String(error)}`, 'kids-guard')
    return { blocked: true, message: blockedMessageFor({ level: 'unavailable' }) }
  } finally {
    if (runningChecks.get(requestId) === controller) runningChecks.delete(requestId)
  }
}

/** Stops a running speech input check (the user pressed Stop). */
export function cancelSpeechInputCheck(requestId: string): void {
  runningChecks.get(requestId)?.abort()
}
