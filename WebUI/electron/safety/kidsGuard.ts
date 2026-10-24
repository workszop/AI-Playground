import fs from 'node:fs'
import path from 'node:path'
import type { UIMessage, UIMessageChunk } from 'ai'
import { appLoggerInstance } from '../observability/logger'

// ── Kids-safe text guard ──────────────────────────────────────────────────────
//
// Every chat prompt, chat reply and image prompt is judged by Qwen3Guard-Gen
// (multilingual, Polish included) on its own llama-server before it reaches a
// model or the screen. Anything but a clean "Safe" verdict blocks, including a
// guard that is missing, failed to start or answered garbage: the filter fails
// closed.

const appLogger = appLoggerInstance

export const KIDS_GUARD_MODEL_REPO =
  'mradermacher/Qwen3Guard-Gen-4B-GGUF/Qwen3Guard-Gen-4B.Q4_K_M.gguf'
export const KIDS_GUARD_MODEL_DIR = 'mradermacher---Qwen3Guard-Gen-4B-GGUF'
export const KIDS_GUARD_MODEL_FILE = 'Qwen3Guard-Gen-4B.Q4_K_M.gguf'

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

// Sized to stay inside the guard server's 4096-token window with the template.
const GUARD_WINDOW_CHARS = 4000
const GUARD_PROMPT_CONTEXT_CHARS = 1500
const GUARD_TIMEOUT_MS = 120_000

export type KidsGuardLevel = 'safe' | 'controversial' | 'unsafe' | 'unavailable'

export type KidsGuardVerdict = {
  level: KidsGuardLevel
  detail?: string
}

export type KidsGuardDeps = {
  /** Directory GGUF LLMs are downloaded into (PathsManager `ggufLLM`). */
  ggufModelDir(): string
  /** Starts (or reuses) the guard llama-server for `modelPath`; resolves to its base URL. */
  ensureGuardServer(modelPath: string): Promise<string>
  /** The shared download-consent flow; rejects when declined or failed. */
  requestModelConsent(models: unknown[]): Promise<void>
}

type GuardMessage = { role: 'user' | 'assistant'; content: string }

let guardDeps: KidsGuardDeps | null = null
let modelReady: Promise<string> | null = null

export function setKidsGuardDeps(deps: KidsGuardDeps | null): void {
  guardDeps = deps
  modelReady = null
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

function guardModelPath(deps: KidsGuardDeps): string {
  return path.join(deps.ggufModelDir(), KIDS_GUARD_MODEL_DIR, KIDS_GUARD_MODEL_FILE)
}

async function ensureGuardModel(deps: KidsGuardDeps): Promise<string> {
  const modelPath = guardModelPath(deps)
  if (fs.existsSync(modelPath)) return modelPath
  await deps.requestModelConsent([
    {
      repo_id: KIDS_GUARD_MODEL_REPO,
      type: 'ggufLLM',
      backend: 'llama_cpp',
      model_path: deps.ggufModelDir(),
    },
  ])
  if (!fs.existsSync(modelPath)) throw new Error(`Safety model not found at ${modelPath}`)
  return modelPath
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
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`Guard server responded with ${response.status}`)
  const body = (await response.json()) as { content?: string }
  return parseGuardVerdict(body.content ?? '')
}

async function judge(
  conversations: GuardMessage[][],
  signal?: AbortSignal,
): Promise<KidsGuardVerdict> {
  try {
    const deps = guardDeps
    if (!deps) throw new Error('Kids guard is not wired')
    modelReady ??= ensureGuardModel(deps).catch((error) => {
      modelReady = null
      throw error
    })
    const baseUrl = await deps.ensureGuardServer(await modelReady)
    for (const messages of conversations) {
      const verdict = await classify(baseUrl, messages, signal)
      if (isBlocked(verdict)) {
        appLogger.info(`Kids guard blocked text (${verdict.level})`, 'kids-guard')
        return verdict
      }
    }
    return { level: 'safe' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    appLogger.warn(`Kids guard unavailable, blocking: ${detail}`, 'kids-guard')
    return { level: 'unavailable', detail }
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

/**
 * Holds a UI message stream until it ends, judges the reply text, then releases
 * it unchanged or replaces it with the blocked message. Reasoning is dropped:
 * it is shown in the chat but is not what the guard judged.
 */
export function guardUiMessageStream(
  stream: ReadableStream<UIMessageChunk>,
  check: (replyText: string) => Promise<KidsGuardVerdict>,
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const held: UIMessageChunk[] = []
      let replyText = ''
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'start') {
            controller.enqueue(chunk)
            continue
          }
          if (chunk.type.startsWith('reasoning-')) continue
          if (chunk.type === 'text-delta') replyText += chunk.delta
          held.push(chunk)
        }
      } catch (error) {
        controller.error(error)
        return
      }
      const verdict = await check(replyText)
      const released = isBlocked(verdict)
        ? [
            ...textOnlyChunks(blockedMessageFor(verdict)),
            ...held.filter(
              (chunk) =>
                chunk.type === 'finish' ||
                chunk.type === 'error' ||
                chunk.type === 'abort' ||
                chunk.type === 'message-metadata',
            ),
          ]
        : held
      for (const chunk of released) controller.enqueue(chunk)
      controller.close()
    },
  })
}
