import { describe, expect, it, vi } from 'vitest'
import type { GuardPlacement } from '../../../safety/guardPlacement'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  net: {},
}))

const { buildGuardServerArgs } = await import('../../../adapters/backends/llamaCppBackendService')

const gpu: GuardPlacement = {
  model: '4B',
  device: { kind: 'gpu', llamaDeviceId: 'Vulkan1' },
  threads: 2,
  batchThreads: 2,
  stopForMedia: false,
}
const cpu: GuardPlacement = {
  model: '0.6B',
  device: { kind: 'cpu' },
  threads: 4,
  batchThreads: 8,
  stopForMedia: true,
}
const base = { modelPath: '/m/guard.gguf', port: 39300 }

describe('buildGuardServerArgs', () => {
  it('pins a gpu placement to its device with 2 threads', () => {
    const args = buildGuardServerArgs({ ...base, placement: gpu })
    expect(args).toEqual([
      '--model',
      '/m/guard.gguf',
      '--port',
      '39300',
      '--ctx-size',
      '6144',
      '--parallel',
      '2',
      '--jinja',
      '--log-prefix',
      '--device',
      'Vulkan1',
      '--gpu-layers',
      '999',
      '-t',
      '2',
      '--host',
      '127.0.0.1',
    ])
  })

  it('keeps a cpu placement off every GPU with its thread counts', () => {
    const args = buildGuardServerArgs({ ...base, placement: cpu })
    expect(args).toEqual([
      '--model',
      '/m/guard.gguf',
      '--port',
      '39300',
      '--ctx-size',
      '6144',
      '--parallel',
      '2',
      '--jinja',
      '--log-prefix',
      '--device',
      'none',
      '--gpu-layers',
      '0',
      '-t',
      '4',
      '-tb',
      '8',
      '--host',
      '127.0.0.1',
    ])
  })

  it('ends with the loopback host for both kinds', () => {
    for (const placement of [gpu, cpu]) {
      expect(buildGuardServerArgs({ ...base, placement }).slice(-2)).toEqual([
        '--host',
        '127.0.0.1',
      ])
    }
  })
})
