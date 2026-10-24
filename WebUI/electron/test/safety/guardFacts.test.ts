import { describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  collectGuardFacts,
  memoizeUntilRejected,
  type GuardFactsDeps,
} from '../../safety/guardFacts'
import {
  GUARD_FOOTPRINT_BYTES,
  planGuardPlacements,
  type GuardPlacement,
} from '../../safety/guardPlacement'
import type { ReferenceAccelerator } from '../../adapters/hardware/deviceArch'

const MIB = 1024 ** 2
const ARC_B580: ReferenceAccelerator = {
  vendor: 'intel',
  name: 'Intel(R) Arc(TM) B580 Graphics',
  gpuDeviceId: '0xE20B',
}
const MTL_IGPU: ReferenceAccelerator = {
  vendor: 'intel',
  name: 'Intel(R) Arc(TM) Graphics',
  gpuDeviceId: '0x7D55',
}
const RTX: ReferenceAccelerator = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4070',
  gpuDeviceId: null,
}
const TOPOLOGY = { performanceCores: 4, efficiencyCores: 8, lowPowerCores: 2, logicalCpus: 14 }

function deps(overrides: Partial<GuardFactsDeps> = {}): GuardFactsDeps {
  return {
    llamaDevices: () => [
      {
        id: '0',
        name: 'Intel(R) Arc(TM) Graphics',
        totalBytes: 16000 * MIB,
        freeBytes: 15000 * MIB,
      },
      {
        id: '1',
        name: 'Intel(R) Arc(TM) B580 Graphics',
        totalBytes: 12000 * MIB,
        freeBytes: 11000 * MIB,
      },
    ],
    selectedDeviceId: () => '1',
    gpuReference: async () => [MTL_IGPU, ARC_B580],
    hostMemory: () => ({ memUsedMiB: 6000, memTotalMiB: 32000 }),
    gpuSamples: () => [],
    platform: () => 'linux',
    cpuTopology: () => TOPOLOGY,
    runningGuard: () => null,
    ...overrides,
  }
}

describe('collectGuardFacts', () => {
  it('uses the selected discrete GPU with its listed memory', async () => {
    const facts = await collectGuardFacts(deps())
    expect(facts).toEqual({
      hardwareClass: 'dgpu',
      gpu: { llamaDeviceId: '1', totalBytes: 12000 * MIB, freeBytes: 11000 * MIB },
      host: { totalBytes: 32000 * MIB, freeBytes: 26000 * MIB },
      cpu: TOPOLOGY,
      allowSmallFallback: true,
    })
  })

  it('follows the selected integrated GPU even when a discrete one exists', async () => {
    const facts = await collectGuardFacts(deps({ selectedDeviceId: () => '0' }))
    expect(facts.hardwareClass).toBe('igpu')
    expect(facts.gpu?.llamaDeviceId).toBe('0')
  })

  it('picks the best GPU, discrete first, when the CPU is selected for chat', async () => {
    const facts = await collectGuardFacts(deps({ selectedDeviceId: () => 'cpu' }))
    expect(facts.hardwareClass).toBe('dgpu')
    expect(facts.gpu?.llamaDeviceId).toBe('1')
  })

  it('classes an NVIDIA card as discrete', async () => {
    const facts = await collectGuardFacts(
      deps({
        llamaDevices: () => [{ id: '0', name: 'NVIDIA GeForce RTX 4070' }],
        selectedDeviceId: () => '0',
        gpuReference: async () => [RTX],
      }),
    )
    expect(facts.hardwareClass).toBe('dgpu')
    expect(facts.gpu).toEqual({ llamaDeviceId: '0', totalBytes: undefined, freeBytes: undefined })
  })

  it('is cpu-only when llama.cpp lists no GPU', async () => {
    const facts = await collectGuardFacts(
      deps({ llamaDevices: () => [], selectedDeviceId: () => '0' }),
    )
    expect(facts.hardwareClass).toBe('cpu-only')
    expect(facts.gpu).toBeUndefined()
  })

  it('ignores listed devices that are not GPUs', async () => {
    const facts = await collectGuardFacts(
      deps({
        llamaDevices: () => [
          { id: 'BLAS', name: 'OpenBLAS' },
          { id: 'cpu', name: 'CPU' },
        ],
        selectedDeviceId: () => 'BLAS',
      }),
    )
    expect(facts.hardwareClass).toBe('cpu-only')
  })

  it('reads the Windows shared GPU cap and use for an integrated GPU', async () => {
    const facts = await collectGuardFacts(
      deps({
        selectedDeviceId: () => '0',
        platform: () => 'win32',
        gpuSamples: () => [
          { id: 'b580', name: 'Intel(R) Arc(TM) B580 Graphics', vendor: 'intel' },
          {
            id: 'mtl',
            name: 'Intel(R) Arc(TM) Graphics',
            vendor: 'intel',
            dedicatedTotalMiB: 128,
            dedicatedUsedMiB: 100,
            sharedTotalMiB: 16000,
            sharedUsedMiB: 4000,
          },
        ],
      }),
    )
    expect(facts.sharedGpuCapBytes).toBe(16128 * MIB)
    expect(facts.sharedGpuUsedBytes).toBe(4100 * MIB)
  })

  it('leaves the shared cap unknown off Windows', async () => {
    const sample = {
      id: 'mtl',
      name: 'Intel(R) Arc(TM) Graphics',
      vendor: 'intel' as const,
      sharedTotalMiB: 16000,
      sharedUsedMiB: 4000,
    }
    const linux = await collectGuardFacts(
      deps({ selectedDeviceId: () => '0', gpuSamples: () => [sample] }),
    )
    expect(linux.sharedGpuCapBytes).toBeUndefined()
    expect(linux.sharedGpuUsedBytes).toBeUndefined()
  })

  it('keeps an integrated GPU off the table on Windows without a matching sample', async () => {
    const facts = await collectGuardFacts(
      deps({
        llamaDevices: () => [{ id: '0', name: 'Intel(R) Arc(TM) Graphics' }],
        selectedDeviceId: () => '0',
        gpuReference: async () => [MTL_IGPU],
        hostMemory: () => ({ memUsedMiB: 2000, memTotalMiB: 64000 }),
        platform: () => 'win32',
      }),
    )
    expect(facts.sharedGpuUsedBytes).toBeUndefined()
    const plan = planGuardPlacements(facts)
    expect(plan.chat.some((placement) => placement.device.kind === 'gpu')).toBe(false)
  })

  it('keeps the shared cap but not the use when only the totals are known', async () => {
    const facts = await collectGuardFacts(
      deps({
        selectedDeviceId: () => '0',
        platform: () => 'win32',
        gpuSamples: () => [
          { id: 'mtl', name: 'Intel(R) Arc(TM) Graphics', vendor: 'intel', sharedTotalMiB: 8000 },
        ],
      }),
    )
    expect(facts.sharedGpuCapBytes).toBe(8000 * MIB)
    expect(facts.sharedGpuUsedBytes).toBeUndefined()
  })

  it('treats an unmatched GPU as integrated when the hardware probe fails', async () => {
    const facts = await collectGuardFacts(
      deps({
        gpuReference: async () => {
          throw new Error('probe failed')
        },
      }),
    )
    expect(facts.hardwareClass).toBe('igpu')
    expect(facts.gpu?.llamaDeviceId).toBe('1')
  })
  it('takes live discrete GPU memory from the compute sample over the listed numbers', async () => {
    const facts = await collectGuardFacts(
      deps({
        gpuSamples: () => [
          {
            id: '1',
            name: 'Intel(R) Arc(TM) B580 Graphics',
            vendor: 'intel',
            dedicatedTotalMiB: 12000,
            dedicatedUsedMiB: 9000,
          },
        ],
      }),
    )
    expect(facts.gpu).toEqual({
      llamaDeviceId: '1',
      totalBytes: 12000 * MIB,
      freeBytes: 3000 * MIB,
    })
  })

  it('reads NVIDIA memory from the vendor sample', async () => {
    const facts = await collectGuardFacts(
      deps({
        llamaDevices: () => [{ id: '0', name: 'NVIDIA GeForce RTX 4070', freeBytes: 1 }],
        selectedDeviceId: () => '0',
        gpuReference: async () => [RTX],
        gpuSamples: () => [
          {
            id: '0',
            name: 'NVIDIA GeForce RTX 4070',
            vendor: 'nvidia',
            memTotalMiB: 12282,
            memUsedMiB: 282,
          },
        ],
      }),
    )
    expect(facts.gpu?.freeBytes).toBe(12000 * MIB)
  })
})

describe('a running guard does not crowd itself out', () => {
  const FOOTPRINT_MIB = GUARD_FOOTPRINT_BYTES['4B'] / MIB
  const placementOf = (device: GuardPlacement['device']): GuardPlacement => ({
    model: '4B',
    device,
    threads: 2,
    batchThreads: 2,
    stopForMedia: false,
  })

  async function plansMatch(idle: GuardFactsDeps, busy: GuardFactsDeps) {
    const idlePlan = planGuardPlacements(await collectGuardFacts(idle))
    const busyPlan = planGuardPlacements(await collectGuardFacts(busy))
    expect(busyPlan).toEqual(idlePlan)
    return idlePlan
  }

  it('credits a CPU guard back to host memory', async () => {
    const cpuOnly = { llamaDevices: () => [], selectedDeviceId: () => 'cpu' }
    const plan = await plansMatch(
      deps({ ...cpuOnly, hostMemory: () => ({ memUsedMiB: 7500, memTotalMiB: 16000 }) }),
      deps({
        ...cpuOnly,
        hostMemory: () => ({ memUsedMiB: 7500 + FOOTPRINT_MIB, memTotalMiB: 16000 }),
        runningGuard: () => placementOf({ kind: 'cpu' }),
      }),
    )
    expect(plan.chat[0].model).toBe('4B')
  })

  it('credits an integrated GPU guard back to host memory and Windows shared use', async () => {
    const igpu = {
      llamaDevices: () => [{ id: '0', name: 'Intel(R) Arc(TM) Graphics' }],
      selectedDeviceId: () => '0',
      gpuReference: async () => [MTL_IGPU],
      platform: () => 'win32' as const,
    }
    const sample = (usedMiB: number) => ({
      id: '0',
      name: 'Intel(R) Arc(TM) Graphics',
      vendor: 'intel' as const,
      dedicatedTotalMiB: 128,
      dedicatedUsedMiB: 0,
      sharedTotalMiB: 8000,
      sharedUsedMiB: usedMiB,
    })
    const plan = await plansMatch(
      deps({
        ...igpu,
        hostMemory: () => ({ memUsedMiB: 7500, memTotalMiB: 16000 }),
        gpuSamples: () => [sample(3000)],
      }),
      deps({
        ...igpu,
        hostMemory: () => ({ memUsedMiB: 7500 + FOOTPRINT_MIB, memTotalMiB: 16000 }),
        gpuSamples: () => [sample(3000 + FOOTPRINT_MIB)],
        runningGuard: () => placementOf({ kind: 'gpu', llamaDeviceId: '0' }),
      }),
    )
    expect(plan.chat[0]).toMatchObject({ model: '4B', device: { kind: 'gpu' } })
  })

  it('credits a discrete GPU guard back to live GPU memory', async () => {
    const sample = (usedMiB: number) => ({
      id: '1',
      name: 'Intel(R) Arc(TM) B580 Graphics',
      vendor: 'intel' as const,
      dedicatedTotalMiB: 12216,
      dedicatedUsedMiB: usedMiB,
    })
    const plan = await plansMatch(
      deps({ gpuSamples: () => [sample(7500)] }),
      deps({
        gpuSamples: () => [sample(7500 + FOOTPRINT_MIB)],
        runningGuard: () => placementOf({ kind: 'gpu', llamaDeviceId: '1' }),
      }),
    )
    expect(plan.chat[0]).toMatchObject({ model: '4B', device: { kind: 'gpu' } })
  })
})

describe('memoizeUntilRejected', () => {
  it('shares one call, keeps a result and retries after a rejection', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('probe failed')).mockResolvedValue(['gpu'])
    const probe = memoizeUntilRejected(load)
    const [first, second] = await Promise.allSettled([probe(), probe()])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(load).toHaveBeenCalledTimes(1)
    expect(await probe()).toEqual(['gpu'])
    expect(await probe()).toEqual(['gpu'])
    expect(load).toHaveBeenCalledTimes(2)
  })
})
