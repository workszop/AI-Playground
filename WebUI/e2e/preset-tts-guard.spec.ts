import { test, expect } from './fixtures'

// Kids-safe build: the text typed into the Text to Speech preset goes through the
// guard before any audio is made. A word-list hit blocks at once, so this needs
// neither the guard model nor a voice model: it proves the renderer → main check
// is wired and that a blocked turn shows the blocked message instead of audio.

const BLOCKED_TEXT = 'porn'
const BLOCKED_MESSAGE = "I can't help with that. Try asking about something else."

test.describe('Text to Speech guard', () => {
  test('blocks unsafe text before any audio is made', async ({ app }) => {
    test.setTimeout(20 * 60_000)
    await app.installAllBackends()
    const ttsAvailable = await app.ensureTtsBackendInstalled()
    expect(ttsAvailable, 'Text-to-Speech must be available (mode supported)').toBe(true)

    const selected = await app.main.selectPreset('Audio', 'Text to Speech')
    expect(selected, 'Preset "Text to Speech" must be available').toBe(true)

    await test.step('Type a blocked word into Text to Speech', async () => {
      await app.main.sendPrompt(BLOCKED_TEXT)
      await app.main.waitUntilIdle()
    })

    await test.step('The turn shows the blocked message and no audio', async () => {
      await expect(app.main.assistantResponses.last()).toContainText(BLOCKED_MESSAGE)
      await expect(app.main.ttsAudioPlayers).toHaveCount(0)
    })
  })
})
