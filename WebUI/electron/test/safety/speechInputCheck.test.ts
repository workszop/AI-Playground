import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

type Verdict = { level: 'safe' | 'unsafe' | 'controversial' | 'unavailable' }
const checkKidsPromptMock = vi.fn(
  async (_text: string, _signal?: AbortSignal): Promise<Verdict> => ({ level: 'safe' }),
)
vi.mock('../../safety/kidsGuard', () => ({
  checkKidsPrompt: checkKidsPromptMock,
  isBlocked: (verdict: Verdict) => verdict.level !== 'safe',
  blockedMessageFor: (verdict: Verdict) => `blocked:${verdict.level}`,
}))

const { cancelSpeechInputCheck, checkSpeechInput, guardVerdictForUi } =
  await import('../../safety/speechInputCheck')

beforeEach(() => {
  checkKidsPromptMock.mockReset()
  checkKidsPromptMock.mockResolvedValue({ level: 'safe' })
})

describe('guardVerdictForUi', () => {
  it('maps a verdict to what the UI shows', async () => {
    expect(await guardVerdictForUi('hi')).toEqual({ blocked: false })
    checkKidsPromptMock.mockResolvedValue({ level: 'controversial' })
    expect(await guardVerdictForUi('hm')).toEqual({
      blocked: true,
      message: 'blocked:controversial',
    })
  })
})

describe('checkSpeechInput', () => {
  it('allows safe speech input', async () => {
    expect(await checkSpeechInput('r1', 'hello')).toEqual({ blocked: false })
    expect(checkKidsPromptMock).toHaveBeenCalledWith('hello', expect.any(AbortSignal))
  })

  it('blocks unsafe speech input with the guard message', async () => {
    checkKidsPromptMock.mockResolvedValue({ level: 'unsafe' })
    expect(await checkSpeechInput('r1', 'bad')).toEqual({
      blocked: true,
      message: 'blocked:unsafe',
    })
  })

  it('fails closed when the guard throws', async () => {
    checkKidsPromptMock.mockRejectedValue(new Error('server down'))
    expect(await checkSpeechInput('r1', 'hello')).toEqual({
      blocked: true,
      message: 'blocked:unavailable',
    })
  })

  it('reports a check stopped by the user as cancelled, not blocked', async () => {
    checkKidsPromptMock.mockImplementation(
      (_text, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('Kids guard check cancelled'))),
        ),
    )
    const pending = checkSpeechInput('r2', 'hello')
    await vi.waitFor(() => expect(checkKidsPromptMock).toHaveBeenCalled())
    cancelSpeechInputCheck('r2')
    expect(await pending).toEqual({ cancelled: true })
  })

  it('reports cancelled even when the guard answers after Stop', async () => {
    let answer!: (verdict: Verdict) => void
    checkKidsPromptMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const pending = checkSpeechInput('r3', 'hello')
    await vi.waitFor(() => expect(checkKidsPromptMock).toHaveBeenCalled())
    cancelSpeechInputCheck('r3')
    answer({ level: 'safe' })
    expect(await pending).toEqual({ cancelled: true })
  })

  it('only cancels the request it is asked to', async () => {
    let answer!: (verdict: Verdict) => void
    checkKidsPromptMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const pending = checkSpeechInput('r4', 'hello')
    await vi.waitFor(() => expect(checkKidsPromptMock).toHaveBeenCalled())
    cancelSpeechInputCheck('other')
    answer({ level: 'safe' })
    expect(await pending).toEqual({ blocked: false })
  })
})
