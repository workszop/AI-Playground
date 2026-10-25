import { describe, expect, it } from 'vitest'
import { validatePreset } from '@/lib/presetSchemas'

describe('removed chat presets', () => {
  it('does not load a stale Home Agent preset from user or persisted files', () => {
    expect(
      validatePreset({
        type: 'chat',
        name: 'Home Agent',
        backends: ['llamaCPP'],
        settings: [],
      }),
    ).toBeNull()
  })

  it('continues to validate ordinary desktop chat presets', () => {
    expect(
      validatePreset({
        type: 'chat',
        name: 'Desktop Chat',
        backends: ['llamaCPP'],
        settings: [],
      }),
    ).toMatchObject({ type: 'chat', name: 'Desktop Chat' })
  })
})
