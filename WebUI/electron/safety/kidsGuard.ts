import fs from 'node:fs'
import path from 'node:path'
import type { UIMessage, UIMessageChunk } from 'ai'
import { appLoggerInstance } from '../observability/logger'
import type { GuardModelSize, GuardPlacement, GuardPlan } from './guardPlacement'

// ── Kids-safe text guard ──────────────────────────────────────────────────────
//
// Every chat prompt, chat reply and image prompt is judged by Qwen3Guard-Gen
// (multilingual, Polish included) on its own llama-server before it reaches a
// model or the screen. Anything but a clean "Safe" verdict blocks, including a
// guard that is missing, failed to start or answered garbage: the filter fails
// closed. Where the guard runs comes from the placement plan; a placement that
// cannot start or answer hands over to the next one in the plan.

const appLogger = appLoggerInstance

export const KIDS_GUARD_MODEL_REPO =
  'mradermacher/Qwen3Guard-Gen-4B-GGUF/Qwen3Guard-Gen-4B.Q4_K_M.gguf'
export const KIDS_GUARD_MODEL_DIR = 'mradermacher---Qwen3Guard-Gen-4B-GGUF'
export const KIDS_GUARD_MODEL_FILE = 'Qwen3Guard-Gen-4B.Q4_K_M.gguf'

export const KIDS_GUARD_SMALL_MODEL_REPO =
  'QuantFactory/Qwen3Guard-Gen-0.6B-GGUF/Qwen3Guard-Gen-0.6B.Q8_0.gguf'
export const KIDS_GUARD_SMALL_MODEL_DIR = 'QuantFactory---Qwen3Guard-Gen-0.6B-GGUF'
export const KIDS_GUARD_SMALL_MODEL_FILE = 'Qwen3Guard-Gen-0.6B.Q8_0.gguf'

/** When false, 0.6B placements are never planned and the 0.6B model is never downloaded. */
export const KIDS_GUARD_ALLOW_SMALL_FALLBACK = true

const GUARD_MODELS: Record<GuardModelSize, { repo: string; dir: string; file: string }> = {
  '4B': { repo: KIDS_GUARD_MODEL_REPO, dir: KIDS_GUARD_MODEL_DIR, file: KIDS_GUARD_MODEL_FILE },
  '0.6B': {
    repo: KIDS_GUARD_SMALL_MODEL_REPO,
    dir: KIDS_GUARD_SMALL_MODEL_DIR,
    file: KIDS_GUARD_SMALL_MODEL_FILE,
  },
}
// A placement that failed this many times in a row is skipped for the rest of the session.
const PLACEMENT_FAILURE_LIMIT = 2

export const KIDS_BLOCKED_MESSAGE =
  'Nie mogę w tym pomóc. Zapytaj o coś innego.\n\n' +
  "I can't help with that. Try asking about something else."

/** Agent turns stream outside the chat guard, so the kids-safe build keeps them off. */
export const KIDS_SAFE_AGENT_MODE_DISABLED = true

const KIDS_GUARD_UNAVAILABLE_MESSAGE =
  'Filtr bezpieczeństwa nie działa, więc ta prośba została zablokowana.\n\n' +
  'The safety filter is not available, so this request was blocked.'

// Explicit words and Polish slang the guard model misses ("cycki", "dopalacze").
// Stems match any ending; whole words match only as written.
const BLOCKED_STEMS = [
  'dopalacz',
  'porn',
  'erotycz',
  'erotyk',
  'seks',
  'pierdol',
  'kurw',
  'jeba',
  'jebi',
  'wyjeb',
  'zajeb',
  'ruchać',
  'ruchani',
  'cipk',
  'kutas',
  'chuj',
  'fuck',
  'hentai',
  'nsfw',
  'nude',
  'nudit',
  'sexual',
  'sexy',
]
const BLOCKED_WORDS = [
  'naga',
  'nagi',
  'nagie',
  'nagiej',
  'nagiego',
  'nagich',
  'nagą',
  'nago',
  'nagość',
  'nagości',
  'golas',
  'golasy',
  'cycki',
  'cycek',
  'cyce',
  'cycuszki',
  'sutki',
  'sutek',
  'cipa',
  'dupa',
  'sex',
  'naked',
  'boobs',
  'boobies',
  'tits',
  'titties',
  'penis',
  'vagina',
  'dick',
  'cunt',
  'koktajl mołotowa',
  'koktajle mołotowa',
  'koktajlu mołotowa',
  'koktajli mołotowa',
  'molotov cocktail',
  'molotov cocktails',
]
const BLOCKLIST_PATTERN = new RegExp(
  `(?<!\\p{L})(?:(?:${BLOCKED_STEMS.join('|')})\\p{L}*|(?:${BLOCKED_WORDS.join('|')})(?!\\p{L}))`,
  'iu',
)

// Sized so a check fits one 3072-token guard slot even at one token per character.
const GUARD_WINDOW_CHARS = 2000
const GUARD_PROMPT_CONTEXT_CHARS = 600
const GUARD_TIMEOUT_MS = 120_000
// Prompt and reply checks use different instructions; each keeps its own cached slot.
const GUARD_PROMPT_SLOT = 0
const GUARD_REPLY_SLOT = 1

// A streamed reply is judged and shown in pieces: a short first piece so text
// appears early, then larger ones, since every check slows the chat model on a
// shared GPU. Overlap plus the largest piece stays within one guard window.
type ReplyPieceSize = { paragraph: number; sentence: number; max: number }
const FIRST_REPLY_PIECE: ReplyPieceSize = { paragraph: 150, sentence: 300, max: 800 }
const LATER_REPLY_PIECE: ReplyPieceSize = { paragraph: 800, sentence: 1200, max: 1600 }
const REPLY_OVERLAP_CHARS = 300

export type KidsGuardLevel = 'safe' | 'controversial' | 'unsafe' | 'unavailable'

export type KidsGuardVerdict = {
  level: KidsGuardLevel
  detail?: string
}

export type KidsGuardDeps = {
  /** Directory GGUF LLMs are downloaded into (PathsManager `ggufLLM`). */
  ggufModelDir(): string
  /** The shared download-consent flow; rejects when declined or failed. */
  requestModelConsent(models: unknown[]): Promise<void>
  /** Where the guard may run right now, best placement first, using only the models on disk. */
  planGuard(modelsOnDisk: GuardModelSize[]): Promise<GuardPlan>
  /** Starts (or reuses) the guard llama-server for `modelPath` on `placement`; resolves to its base URL. */
  ensureGuardServer(modelPath: string, placement: GuardPlacement): Promise<string>
  /** Whether an image run holds the GPU window. */
  mediaWindowActive(): boolean
  /** Resolves once the GPU window is back on chat. */
  awaitChatWindow(signal?: AbortSignal): Promise<void>
  /** The placement of the guard server that is up now, or null. */
  runningGuardPlacement(): GuardPlacement | null
}

type GuardMessage = { role: 'user' | 'assistant'; content: string }

let guardDeps: KidsGuardDeps | null = null
let modelsReady: Promise<void> | null = null
let checksActive = 0
const placementFailures = new Map<string, number>()
// Bumped whenever a check asks for a different placement than the last one asked for (a restart).
let guardSwitches = 0
let lastRequestedKey: string | null = null

export function setKidsGuardDeps(deps: KidsGuardDeps | null): void {
  guardDeps = deps
  modelsReady = null
  placementFailures.clear()
  guardSwitches = 0
  lastRequestedKey = null
}

/** Guard checks in flight; a media window waits for them before taking the GPU. */
export function kidsGuardChecksActive(): number {
  return checksActive
}

export function isBlocked(verdict: KidsGuardVerdict): boolean {
  return verdict.level !== 'safe'
}

export function blockedMessageFor(verdict: KidsGuardVerdict): string {
  return verdict.level === 'unavailable' ? KIDS_GUARD_UNAVAILABLE_MESSAGE : KIDS_BLOCKED_MESSAGE
}

/** Reads the `Safety: …` line Qwen3Guard-Gen starts every answer with. */
export function parseGuardVerdict(text: string): KidsGuardVerdict {
  const match = /Safety:\s*(Safe|Unsafe|Controversial)\b/i.exec(text)
  if (!match)
    return { level: 'unavailable', detail: `Unparseable guard answer: ${text.slice(0, 80)}` }
  return { level: match[1].toLowerCase() as KidsGuardLevel }
}

/** Splits long text so no part of it is cut off by the guard's context window. */
export function guardWindows(text: string): string[] {
  const windows: string[] = []
  for (let start = 0; start < text.length; start += GUARD_WINDOW_CHARS) {
    windows.push(text.slice(start, start + GUARD_WINDOW_CHARS))
  }
  return windows
}

/** Text of the newest user message in a UI message list. */
export function lastUserText(messages: unknown[]): string {
  const user = [...(messages as UIMessage[])].reverse().find((m) => m?.role === 'user')
  if (!user || !Array.isArray(user.parts)) return ''
  return user.parts
    .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function guardModelPath(deps: KidsGuardDeps, model: GuardModelSize): string {
  const { dir, file } = GUARD_MODELS[model]
  return path.join(deps.ggufModelDir(), dir, file)
}

function wantedGuardModels(): GuardModelSize[] {
  return KIDS_GUARD_ALLOW_SMALL_FALLBACK ? ['4B', '0.6B'] : ['4B']
}

function guardModelsOnDisk(deps: KidsGuardDeps): GuardModelSize[] {
  return wantedGuardModels().filter((model) => fs.existsSync(guardModelPath(deps, model)))
}

/** Asks once for every missing guard model, so a fallback never downloads mid-session. */
async function ensureGuardModels(deps: KidsGuardDeps): Promise<void> {
  const onDisk = (model: GuardModelSize) => fs.existsSync(guardModelPath(deps, model))
  const missing = wantedGuardModels().filter((model) => !onDisk(model))
  if (missing.length > 0) {
    await deps
      .requestModelConsent(
        missing.map((model) => ({
          repo_id: GUARD_MODELS[model].repo,
          type: 'ggufLLM',
          backend: 'llama_cpp',
          model_path: deps.ggufModelDir(),
        })),
      )
      .catch((error) => appLogger.warn(`Safety model download: ${String(error)}`, 'kids-guard'))
  }
  if (!wantedGuardModels().some(onDisk)) {
    throw new Error(`No safety model found in ${deps.ggufModelDir()}`)
  }
}

/** Drops chat-template control tokens and policy markers a child could type to steer the guard. */
export function neutralizeGuardInput(text: string): string {
  return text.replace(/<\|[^|>]*\|>/g, '').replace(/<\s*(BEGIN|END)\b[^>]*>/gi, '')
}

/**
 * Qwen3Guard-Gen's own chat template, rendered here. Sent through `/completion`
 * because llama-server's chat endpoint continues a trailing assistant message
 * instead of judging it.
 */
export function buildGuardPrompt(messages: GuardMessage[]): string {
  const judgesResponse = messages[messages.length - 1]?.role === 'assistant'
  const subject = judgesResponse ? "ASSISTANT's response" : "USER's query"
  const conversation = messages
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${neutralizeGuardInput(m.content)}`)
    .join('\n\n')
  const policy = judgesResponse
    ? [
        "**Safety: Safe**: The ASSISTANT's response does not contain any prohibited content or content that could lead to prohibited content.",
        "**Safety: Unsafe**: The ASSISTANT's response contains prohibited content.",
        "**Safety: Controversial**: The ASSISTANT's response is not explicitly harmful, but could become risky or offensive depending on context or audience.",
      ]
    : [
        "**Safety: Safe**: The USER's query does not contain any prohibited content or content that could lead to prohibited content.",
        "**Safety: Unsafe**: The USER's query contains prohibited content.",
        "**Safety: Controversial**: The USER's query does not explicitly contain prohibited content, but its intent, context, or potential responses could be misinterpreted, misused, or exploited to generate unsafe content under certain conditions.",
      ]
  const categories = [
    'Violent.',
    'Non-violent Illegal Acts.',
    'Sexual Content or Sexual Acts.',
    'PII.',
    'Suicide & Self-Harm.',
    'Unethical Acts.',
    'Politically Sensitive Topics.',
    'Copyright Violation.',
    ...(judgesResponse ? [] : ['Jailbreak.']),
  ]
  const tasks = [
    `1) Evaluate whether THE LAST ${judgesResponse ? 'ASSISTANT' : 'USER'}'s ${judgesResponse ? 'response' : 'query'} belongs to safe or unsafe content based on our safety policy.`,
    '2) Identify the category of unsafe content found.',
    ...(judgesResponse
      ? ["3) Determine if THE LAST ASSISTANT's response is a refusal to the USER's query."]
      : []),
  ]
  const refusalPolicy = judgesResponse
    ? [
        '<BEGIN REFUSAL POLICY>',
        "**Refusal: Yes**: The ASSISTANT refused to answer or did not comply with the USER's request.",
        "**Refusal: No**: The ASSISTANT directly answered or complied with the USER's request.",
        '<END REFUSAL POLICY>',
        '',
      ]
    : []
  const answerFormat = [
    " - The first line must be one of: 'Safety: Safe', 'Safety: Unsafe', 'Safety: Controversial'.",
    " - The second line should start with 'Categories:' followed by a list of any unsafe content categories, separated by commas. If the content is safe, use 'Categories: None'.",
    ...(judgesResponse ? [" - The third line must be one of: 'Refusal: Yes', 'Refusal: No'."] : []),
  ]
  return [
    '<|im_start|>user',
    '# Task:',
    ...tasks,
    '',
    '<BEGIN SAFETY POLICY>',
    ...policy,
    '<END SAFETY POLICY>',
    '',
    '<BEGIN UNSAFE CONTENT CATEGORIES>',
    ...categories,
    '<END UNSAFE CONTENT CATEGORIES>',
    '',
    ...refusalPolicy,
    '<BEGIN CONVERSATION>',
    '',
    conversation,
    '',
    '<END CONVERSATION>',
    '',
    `Provide your safety assessment for ONLY THE LAST **${subject}** in the above conversation:`,
    `${answerFormat.join('\n')}<|im_end|>`,
    '<|im_start|>assistant',
    '<think>',
    '',
    '</think>',
    '',
    '',
  ].join('\n')
}

async function classify(
  baseUrl: string,
  messages: GuardMessage[],
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  const timeout = AbortSignal.timeout(GUARD_TIMEOUT_MS)
  const response = await fetch(`${baseUrl}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The verdict is the first line; categories and the refusal flag are not needed.
    body: JSON.stringify({
      prompt: buildGuardPrompt(messages),
      temperature: 0,
      n_predict: 8,
      stop: ['\n'],
      cache_prompt: true,
      id_slot:
        messages[messages.length - 1]?.role === 'assistant' ? GUARD_REPLY_SLOT : GUARD_PROMPT_SLOT,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`Guard server responded with ${response.status}`)
  const body = (await response.json()) as { content?: string }
  return parseGuardVerdict(body.content ?? '')
}

const errorDetail = (error: unknown) => (error instanceof Error ? error.message : String(error))

function placementKey(placement: GuardPlacement): string {
  const { device } = placement
  return `${placement.model}:${device.kind}:${device.kind === 'gpu' ? device.llamaDeviceId : ''}`
}

type GuardChoice = { media: boolean; placements: GuardPlacement[] }

/** The media list while an image run holds the GPU; when it is empty, the chat list after the window. */
async function chooseGuardPlacements(
  deps: KidsGuardDeps,
  signal?: AbortSignal,
): Promise<GuardChoice> {
  for (;;) {
    const plan = await deps.planGuard(guardModelsOnDisk(deps))
    const media = deps.mediaWindowActive()
    if (!media) return { media, placements: plan.chat }
    if (plan.media.length > 0) return { media, placements: plan.media }
    await deps.awaitChatWindow(signal)
  }
}

/** Placements whose model is on disk; the last of them is the last resort. */
function placementsOnDisk(deps: KidsGuardDeps, choice: GuardChoice): GuardPlacement[] {
  return choice.placements.filter((placement) =>
    fs.existsSync(guardModelPath(deps, placement.model)),
  )
}

async function judgeOn(
  baseUrl: string,
  conversations: GuardMessage[][],
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  for (const messages of conversations) {
    const verdict = await classify(baseUrl, messages, signal)
    if (isBlocked(verdict)) return verdict
  }
  return { level: 'safe' }
}

async function judgeWithFallback(
  deps: KidsGuardDeps,
  conversations: GuardMessage[][],
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  modelsReady ??= ensureGuardModels(deps).catch((error) => {
    modelsReady = null
    throw error
  })
  await modelsReady
  let choice = await chooseGuardPlacements(deps, signal)
  let candidates = placementsOnDisk(deps, choice)
  let replanned = false
  const triedHere = new Set<string>()
  let lastError: unknown = new Error('No guard placement can run')
  for (let index = 0; index < candidates.length; index++) {
    const placement = candidates[index]
    const key = placementKey(placement)
    const lastResort = index === candidates.length - 1
    if (triedHere.has(key)) continue
    if (!lastResort && (placementFailures.get(key) ?? 0) >= PLACEMENT_FAILURE_LIMIT) continue
    // The window flipped since this list was chosen: never start a guard from the other window's list.
    if (deps.mediaWindowActive() !== choice.media) {
      choice = await chooseGuardPlacements(deps, signal)
      candidates = placementsOnDisk(deps, choice)
      index = -1
      continue
    }
    triedHere.add(key)
    let started = false
    if (lastRequestedKey !== key) {
      guardSwitches++
      lastRequestedKey = key
    }
    const switchesAtStart = guardSwitches
    try {
      const baseUrl = await deps.ensureGuardServer(guardModelPath(deps, placement.model), placement)
      started = true
      // An unparseable answer comes back as a verdict and blocks; only failures to start or answer fall back.
      const verdict = await judgeOn(baseUrl, conversations, signal)
      placementFailures.delete(key)
      return verdict
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
      const running = deps.runningGuardPlacement()
      // A window flip or another check's restart is not this placement's fault: plan again instead.
      // A guard that is simply gone without either is a crash and counts.
      const interrupted =
        deps.mediaWindowActive() !== choice.media ||
        guardSwitches !== switchesAtStart ||
        (started && running !== null && placementKey(running) !== key)
      appLogger.warn(
        `Kids guard on ${key} failed${interrupted ? ' (interrupted)' : ''}: ${errorDetail(error)}`,
        'kids-guard',
      )
      if (interrupted && !replanned) {
        replanned = true
        triedHere.delete(key)
        choice = await chooseGuardPlacements(deps, signal)
        candidates = placementsOnDisk(deps, choice)
        index = -1
        continue
      }
      if (!interrupted && !lastResort) {
        placementFailures.set(key, (placementFailures.get(key) ?? 0) + 1)
      }
    }
  }
  throw lastError
}

async function judge(
  conversations: GuardMessage[][],
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  checksActive++
  try {
    const deps = guardDeps
    if (!deps) throw new Error('Kids guard is not wired')
    const verdict = await judgeWithFallback(deps, conversations, signal)
    if (isBlocked(verdict))
      appLogger.info(`Kids guard blocked text (${verdict.level})`, 'kids-guard')
    return verdict
  } catch (error) {
    const detail = errorDetail(error)
    appLogger.warn(`Kids guard unavailable, blocking: ${detail}`, 'kids-guard')
    return { level: 'unavailable', detail }
  } finally {
    checksActive--
  }
}

export function matchesBlocklist(text: string): boolean {
  return BLOCKLIST_PATTERN.test(text.normalize('NFC'))
}

/** Judges text a child typed (chat message or image prompt). */
export async function checkKidsPrompt(
  prompt: string,
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  if (!prompt.trim()) return { level: 'safe' }
  if (matchesBlocklist(prompt)) return { level: 'unsafe', detail: 'blocklist' }
  return judge(
    guardWindows(prompt).map((window) => [{ role: 'user', content: window }]),
    signal,
  )
}

/** Judges a model reply in the context of the prompt that produced it. */
export async function checkKidsResponse(
  prompt: string,
  response: string,
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  if (!response.trim()) return { level: 'safe' }
  if (matchesBlocklist(response)) return { level: 'unsafe', detail: 'blocklist' }
  const context = prompt.slice(-GUARD_PROMPT_CONTEXT_CHARS)
  return judge(
    guardWindows(response).map((window) => [
      { role: 'user', content: context },
      { role: 'assistant', content: window },
    ]),
    signal,
  )
}

/** The chunks of an assistant message that only says `text`. */
export function textOnlyChunks(text: string): UIMessageChunk[] {
  return [
    { type: 'text-start', id: 'kids-guard' },
    { type: 'text-delta', id: 'kids-guard', delta: text },
    { type: 'text-end', id: 'kids-guard' },
  ]
}

/** Whether the unreleased reply text has reached a natural point to be judged and shown. */
export function replyPieceReady(piece: string, firstPiece: boolean): boolean {
  const size = firstPiece ? FIRST_REPLY_PIECE : LATER_REPLY_PIECE
  if (piece.length >= size.max) return true
  if (piece.length >= size.paragraph && /\n\s*\n\s*$/.test(piece)) return true
  return piece.length >= size.sentence && /[.!?…:]["')\]]?\s*$/.test(piece)
}

/**
 * Releases a UI message stream piece by piece: reply text is held until it
 * reaches a paragraph or sentence break, judged together with the tail of what
 * is already on screen, and only then shown. The model keeps streaming while a
 * piece is judged. A blocked piece is never shown: the open text is closed, the
 * blocked message is appended, the source is cancelled and `onBlocked` fires so
 * the caller can stop generation. Reasoning is dropped, since it is not judged.
 */
export function guardUiMessageStream(
  stream: ReadableStream<UIMessageChunk>,
  check: (replyText: string) => Promise<KidsGuardVerdict>,
  onBlocked?: () => void,
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader()
  const incoming: UIMessageChunk[] = []
  let sourceDone = false
  let sourceError: unknown = undefined
  let wake: (() => void) | null = null
  const notify = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        incoming.push(value)
        notify()
      }
    } catch (error) {
      sourceError = error ?? new Error('Reply stream failed')
    } finally {
      sourceDone = true
      notify()
    }
  })()
  const nextChunk = async (): Promise<UIMessageChunk | undefined> => {
    while (incoming.length === 0 && !sourceDone) {
      await new Promise<void>((resolve) => (wake = resolve))
    }
    return incoming.shift()
  }

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const openText = new Set<string>()
      let held: UIMessageChunk[] = []
      let piece = ''
      let shown = ''

      const emit = (chunk: UIMessageChunk) => {
        if (chunk.type === 'text-start') openText.add(chunk.id)
        if (chunk.type === 'text-end') openText.delete(chunk.id)
        controller.enqueue(chunk)
      }
      // Resolves false when the piece was blocked and the stream is finished.
      const settlePiece = async (): Promise<boolean> => {
        if (piece.trim()) {
          const verdict = await check(shown.slice(-REPLY_OVERLAP_CHARS) + piece)
          if (isBlocked(verdict)) {
            for (const id of openText) controller.enqueue({ type: 'text-end', id })
            for (const chunk of textOnlyChunks(blockedMessageFor(verdict)))
              controller.enqueue(chunk)
            controller.enqueue({ type: 'finish' })
            controller.close()
            onBlocked?.()
            await reader.cancel().catch(() => {})
            return false
          }
        }
        held.forEach(emit)
        held = []
        shown += piece
        piece = ''
        return true
      }

      for (;;) {
        const chunk = await nextChunk()
        if (!chunk) break
        if (chunk.type === 'start') {
          emit(chunk)
          continue
        }
        if (chunk.type.startsWith('reasoning-')) continue
        if (chunk.type === 'text-delta') {
          piece += chunk.delta
          held.push(chunk)
          if (replyPieceReady(piece, !shown) && !(await settlePiece())) return
          continue
        }
        if (chunk.type === 'text-start') {
          held.push(chunk)
          continue
        }
        // Anything else (text end, tool activity, step and finish markers) closes the piece.
        if (!(await settlePiece())) return
        emit(chunk)
      }
      if (!(await settlePiece())) return
      if (sourceError !== undefined) controller.error(sourceError)
      else controller.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
