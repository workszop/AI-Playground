import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkedImageOutputs,
  IMAGE_NSFW_THRESHOLD,
  imageFilterProblem,
  restoreSafetyCheckerNode,
  safetyThreshold,
} from '../../safety/imageFilter'
import { applyVariant, type ComfyUIApiWorkflow, type Preset } from '@/lib/presetSchemas'
import { devPresets } from '@/lib/devPresetWorkflows'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SHIPPED_NODE_DIR = path.join(REPO_ROOT, 'comfyui-deps', 'custom_nodes', 'SafetyChecker')

function workflow(threshold: unknown, saveFrom: [string, number] = ['3', 0]): ComfyUIApiWorkflow {
  return {
    '1': { class_type: 'VAEDecode', inputs: {} },
    '2': {
      class_type: 'CM_FloatBinaryOperation',
      inputs: { op: 'Sub', a: 1, b: 0.6 },
      _meta: { title: 'SafetyCheckerStrength' },
    },
    '3': { class_type: 'SafetyChecker', inputs: { image: ['1', 0], threshold } },
    '4': { class_type: 'SaveImage', inputs: { images: saveFrom } },
  } as unknown as ComfyUIApiWorkflow
}

describe('safetyThreshold', () => {
  const node = (threshold: unknown) => ({ class_type: 'SafetyChecker', inputs: { threshold } })

  it('reads a number or the strength subtraction', () => {
    expect(safetyThreshold(workflow(0.4), node(0.4))).toBe(0.4)
    expect(safetyThreshold(workflow(['2', 0]), node(['2', 0]))).toBeCloseTo(0.4)
  })

  it('is unknown for anything else', () => {
    const wf = workflow(['2', 0])
    ;(wf['2'] as { inputs: Record<string, unknown> }).inputs.op = 'Add'
    expect(safetyThreshold(wf, node(['2', 0]))).toBeUndefined()
    expect(safetyThreshold(wf, node(['1', 0]))).toBeUndefined()
    expect(safetyThreshold(wf, node('0.1'))).toBeUndefined()
    expect(safetyThreshold(wf, node(undefined))).toBeUndefined()
  })
})

describe('imageFilterProblem', () => {
  it('accepts a saved image that comes straight from a strict SafetyChecker', () => {
    expect(imageFilterProblem(workflow(['2', 0]), 'image')).toBeNull()
    expect(imageFilterProblem(workflow(IMAGE_NSFW_THRESHOLD), 'image')).toBeNull()
    expect(imageFilterProblem(workflow(0.1), 'image')).toBeNull()
    expect(checkedImageOutputs(workflow(0.4))).toEqual(new Set(['4']))
  })

  it('refuses a threshold above 0.4', () => {
    expect(imageFilterProblem(workflow(0.41), 'image')).toMatch(/threshold/)
    const raised = workflow(['2', 0])
    ;(raised['2'] as { inputs: Record<string, unknown> }).inputs.b = 0.5
    expect(imageFilterProblem(raised, 'image')).toMatch(/threshold/)
  })

  it('refuses a saved image that skips the SafetyChecker', () => {
    expect(imageFilterProblem(workflow(0.4, ['1', 0]), 'image')).toMatch(/not fed/)
    // Slot 1 is the score string, not the filtered image.
    expect(imageFilterProblem(workflow(0.4, ['3', 1]), 'image')).toMatch(/not fed/)
  })

  it('refuses a saver of any class that skips the SafetyChecker', () => {
    const wf = workflow(0.4)
    wf['5'] = { class_type: 'Image Save', inputs: { images: ['1', 0] } } as never
    expect(imageFilterProblem(wf, 'image')).toMatch(/Image Save node 5 is not fed/)
    wf['5'] = { class_type: 'PreviewImage', inputs: { images: ['1', 0] } } as never
    expect(imageFilterProblem(wf, 'image')).toMatch(/PreviewImage node 5 is not fed/)
  })

  it('refuses a saver that also passes its images onward', () => {
    const wf = workflow(0.4)
    wf['5'] = { class_type: 'Image Save', inputs: { images: ['1', 0] } } as never
    wf['6'] = { class_type: 'ImageInvert', inputs: { images: ['5', 0] } } as never
    expect(imageFilterProblem(wf, 'image')).toMatch(/Image Save node 5 is not fed/)
  })

  it('allows an unfiltered image to feed another node on its way to the checker', () => {
    const wf = workflow(0.4)
    wf['1'] = { class_type: 'VAEDecode', inputs: {} } as never
    wf['6'] = { class_type: 'ImageScale', inputs: { image: ['1', 0] } } as never
    wf['7'] = { class_type: 'ImageInvert', inputs: { images: ['6', 0] } } as never
    ;(wf['3'] as { inputs: Record<string, unknown> }).inputs.image = ['7', 0]
    expect(imageFilterProblem(wf, 'image')).toBeNull()
  })

  it('refuses an image workflow with no filtered output', () => {
    const wf = workflow(0.4)
    delete wf['4']
    expect(imageFilterProblem(wf, 'image')).toMatch(/no image output/)
  })

  it('leaves a video preset whose output node takes images alone', () => {
    const video = {
      '1': { class_type: 'VAEDecode', inputs: {} },
      '2': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0] } },
    } as unknown as ComfyUIApiWorkflow
    expect(imageFilterProblem(video, 'video')).toBeNull()
    expect(imageFilterProblem(video, 'image')).toMatch(/VHS_VideoCombine node 2 is not fed/)
  })

  it('leaves video workflows alone', () => {
    const video = {
      '1': { class_type: 'VAEDecode', inputs: {} },
      '2': { class_type: 'SaveVideo', inputs: { video: ['1', 0] } },
    } as unknown as ComfyUIApiWorkflow
    expect(imageFilterProblem(video, 'video')).toBeNull()
  })
})

describe('shipped presets', () => {
  // Acer's partner preset saves through its own animation node, so the kids-safe build refuses it.
  const KNOWN_REFUSED = new Set(['AcerVisionArt_fluxQ4.json'])

  const cases: [string, ComfyUIApiWorkflow, string | undefined][] = []
  for (const mode of readdirSync(path.join(REPO_ROOT, 'modes'))) {
    const dir = path.join(REPO_ROOT, 'modes', mode, 'presets')
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((file) => file.endsWith('.json'))
    } catch {
      continue
    }
    for (const file of files) {
      const preset = JSON.parse(readFileSync(path.join(dir, file), 'utf-8')) as Preset
      if (preset.type !== 'comfy' || KNOWN_REFUSED.has(file)) continue
      // A run uses the preset with its chosen variant merged in, as the app applies it.
      const runnable = [
        { name: `${mode}/${file}`, preset },
        ...(preset.variants ?? []).map((variant) => ({
          name: `${mode}/${file}#${variant.name}`,
          preset: applyVariant(preset, variant.name),
        })),
      ]
      for (const { name, preset: applied } of runnable) {
        if (applied.type === 'comfy' && applied.comfyUiApiWorkflow) {
          cases.push([name, applied.comfyUiApiWorkflow, applied.mediaType])
        }
      }
    }
  }

  it('finds the presets', () => {
    expect(cases.length).toBeGreaterThan(20)
  })

  it('refuses the Acer preset', () => {
    const file = path.join(REPO_ROOT, 'modes', 'base', 'presets', 'AcerVisionArt_fluxQ4.json')
    const acer = JSON.parse(readFileSync(file, 'utf-8')) as {
      comfyUiApiWorkflow: ComfyUIApiWorkflow
    }
    expect(imageFilterProblem(acer.comfyUiApiWorkflow, undefined)).toMatch(/AcerSaveImage/)
  })

  it.each(cases)('%s keeps its image filter', (_name, wf, mediaType) => {
    expect(imageFilterProblem(wf, mediaType)).toBeNull()
  })
})

describe('dev dummy presets', () => {
  it.each(devPresets.map((p) => [p.name, p] as const))('%s keeps its image filter', (_n, p) => {
    expect(p.type === 'comfy' && imageFilterProblem(p.comfyUiApiWorkflow, p.mediaType)).toBeNull()
  })
})

describe('restoreSafetyCheckerNode', () => {
  let comfyDir: string
  const nodeFile = (name: string) => path.join(comfyDir, 'custom_nodes', 'SafetyChecker', name)
  const shipped = (name: string) => readFileSync(path.join(SHIPPED_NODE_DIR, name), 'utf-8')

  beforeEach(() => {
    comfyDir = mkdtempSync(path.join(os.tmpdir(), 'aipg-comfy-'))
  })

  afterEach(() => {
    rmSync(comfyDir, { recursive: true, force: true })
  })

  it('does nothing before ComfyUI is installed', async () => {
    expect(await restoreSafetyCheckerNode(comfyDir)).toBe(false)
    expect(readdirSync(comfyDir)).toEqual([])
  })

  it('writes missing node files', async () => {
    mkdirSync(path.join(comfyDir, 'custom_nodes'))
    expect(await restoreSafetyCheckerNode(comfyDir)).toBe(true)
    expect(readFileSync(nodeFile('nodes.py'), 'utf-8')).toBe(shipped('nodes.py'))
    expect(readFileSync(nodeFile('__init__.py'), 'utf-8')).toBe(shipped('__init__.py'))
  })

  it('leaves the shipped files alone, also with Windows line endings', async () => {
    mkdirSync(path.dirname(nodeFile('nodes.py')), { recursive: true })
    writeFileSync(nodeFile('nodes.py'), shipped('nodes.py').replace(/\n/g, '\r\n'))
    writeFileSync(nodeFile('__init__.py'), shipped('__init__.py'))
    expect(await restoreSafetyCheckerNode(comfyDir)).toBe(false)
  })

  it('restores a changed node file', async () => {
    mkdirSync(path.dirname(nodeFile('nodes.py')), { recursive: true })
    writeFileSync(nodeFile('nodes.py'), 'class SafetyChecker: pass\n')
    writeFileSync(nodeFile('__init__.py'), shipped('__init__.py'))
    expect(await restoreSafetyCheckerNode(comfyDir)).toBe(true)
    expect(readFileSync(nodeFile('nodes.py'), 'utf-8')).toBe(shipped('nodes.py'))
  })
})
