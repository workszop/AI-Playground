import { beforeEach, describe, expect, it, vi } from 'vitest'
import { devPresets } from '@/lib/devPresetWorkflows'

const state = vi.hoisted(() => ({ dummyOnly: false, presets: [] as unknown[] }))

vi.mock('@/assets/js/store/presets', () => ({ usePresets: () => ({ presets: state.presets }) }))
vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ isWorkflowPresetEnabled: () => true }),
}))
vi.mock('@/assets/js/store/devPresets', async () => {
  const { DEV_PRESET_NAMES } = await import('@/lib/devPresetWorkflows')
  return { DEV_PRESET_NAMES, dummyWorkflowsOnly: () => state.dummyOnly }
})

const { getAvailableWorkflows } = await import('@/assets/js/tools/comfyUi')
const { getAvailableEditWorkflows } = await import('@/assets/js/tools/comfyUiImageEdit')

const realPreset = (name: string, toolCategory: string) => ({
  type: 'comfy',
  backend: 'comfyui',
  name,
  toolCategory,
  mediaType: 'image',
})

beforeEach(() => {
  state.dummyOnly = false
  state.presets = [
    realPreset('Draft Image', 'create-images'),
    realPreset('Edit Image', 'edit-images'),
    ...devPresets,
  ]
})

const names = (workflows: { name: string }[]) => workflows.map((w) => w.name)

describe('media tool workflow catalogs', () => {
  it('never offer a dummy workflow on a real run', () => {
    expect(names(getAvailableWorkflows())).toEqual(['Draft Image'])
    expect(names(getAvailableEditWorkflows())).toEqual(['Edit Image'])
  })

  it('offer only the dummies under the developer override', () => {
    state.dummyOnly = true
    expect(names(getAvailableWorkflows())).toEqual(['Dummy Image (test)', 'Dummy Video (test)'])
    expect(names(getAvailableEditWorkflows())).toEqual([
      'Dummy Edit (test)',
      'Dummy 3D Model (test)',
    ])
  })
})
