import { describe, expect, it } from 'vitest'
import { planGuardPlacements, type GuardFacts } from '../../safety/guardPlacement'

const GIB = 1024 ** 3
const cpu = { performanceCores: 4, logicalCpus: 8 }
const vulkan = (totalGiB: number, freeGiB?: number) => ({
  llamaDeviceId: 'Vulkan0',
  totalBytes: totalGiB * GIB,
  freeBytes: freeGiB === undefined ? undefined : freeGiB * GIB,
})
const host = (totalGiB: number, freeGiB?: number) => ({
  totalBytes: totalGiB * GIB,
  freeBytes: freeGiB === undefined ? undefined : freeGiB * GIB,
})
const facts = (overrides: Partial<GuardFacts>): GuardFacts => ({
  hardwareClass: 'cpu-only',
  host: host(32, 20),
  cpu,
  allowSmallFallback: true,
  ...overrides,
})
const chain = (input: GuardFacts) =>
  planGuardPlacements(input).chat.map(
    (p) => `${p.model} ${p.device.kind === 'gpu' ? 'gpu' : 'cpu'}`,
  )

describe('planGuardPlacements', () => {
  it('cpu-only with room plans both models on cpu', () => {
    const plan = planGuardPlacements(facts({}))
    expect(plan.chat).toEqual([
      { model: '4B', device: { kind: 'cpu' }, threads: 4, batchThreads: 4, stopForMedia: false },
      { model: '0.6B', device: { kind: 'cpu' }, threads: 4, batchThreads: 4, stopForMedia: false },
    ])
    expect(plan.media).toEqual(plan.chat)
  })

  it('cpu-only with little free RAM keeps only the last resort', () => {
    expect(chain(facts({ host: host(8, 5) }))).toEqual(['0.6B cpu'])
  })

  it('igpu 16 GB with ~6 GB free drops 4B', () => {
    const plan = planGuardPlacements(
      facts({ hardwareClass: 'igpu', gpu: vulkan(16, 16), host: host(16, 6) }),
    )
    expect(plan.chat.map((p) => `${p.model} ${p.device.kind}`)).toEqual(['0.6B gpu', '0.6B cpu'])
    expect(plan.chat.every((p) => p.stopForMedia)).toBe(true)
    expect(plan.media).toEqual([])
  })

  it('igpu 32 GB with ~20 GB free plans everything', () => {
    const plan = planGuardPlacements(
      facts({ hardwareClass: 'igpu', gpu: vulkan(32, 32), host: host(32, 20) }),
    )
    expect(plan.chat.map((p) => `${p.model} ${p.device.kind}`)).toEqual([
      '4B gpu',
      '4B cpu',
      '0.6B gpu',
      '0.6B cpu',
    ])
    expect(plan.chat[0]).toMatchObject({
      device: { kind: 'gpu', llamaDeviceId: 'Vulkan0' },
      threads: 2,
      batchThreads: 2,
    })
  })

  it('dgpu 8 GB prefers 4B on cpu and 0.6B on gpu', () => {
    const plan = planGuardPlacements(
      facts({ hardwareClass: 'dgpu', gpu: vulkan(8, 7), host: host(32, 20) }),
    )
    expect(plan.chat.map((p) => `${p.model} ${p.device.kind}`)).toEqual([
      '4B cpu',
      '0.6B gpu',
      '0.6B cpu',
    ])
    expect(plan.media.map((p) => `${p.model} ${p.device.kind}`)).toEqual(['4B cpu', '0.6B cpu'])
  })

  it('dgpu 16 GB with chat loaded leaving 3 GB free', () => {
    expect(chain(facts({ hardwareClass: 'dgpu', gpu: vulkan(16, 3), host: host(32, 20) }))).toEqual(
      ['4B cpu', '0.6B gpu', '0.6B cpu'],
    )
  })

  it('dgpu 16 GB with plenty free starts on gpu', () => {
    expect(
      chain(facts({ hardwareClass: 'dgpu', gpu: vulkan(16, 12), host: host(32, 20) })),
    ).toEqual(['4B gpu', '4B cpu', '0.6B gpu', '0.6B cpu'])
  })

  it('missing metrics leave only the last resort', () => {
    expect(
      chain(facts({ hardwareClass: 'dgpu', gpu: vulkan(16), host: { totalBytes: 32 * GIB } })),
    ).toEqual(['0.6B cpu'])
  })

  it('unknown dgpu size is treated as small', () => {
    const input = facts({
      hardwareClass: 'dgpu',
      gpu: { llamaDeviceId: 'Vulkan0', freeBytes: 6 * GIB },
    })
    expect(chain(input)).toEqual(['4B cpu', '0.6B gpu', '0.6B cpu'])
  })

  it('drops gpu candidates without a gpu', () => {
    expect(chain(facts({ hardwareClass: 'igpu' }))).toEqual(['4B cpu', '0.6B cpu'])
  })

  it('allowSmallFallback false never plans 0.6B and keeps 4B cpu as last resort', () => {
    expect(chain(facts({ allowSmallFallback: false, host: host(8, 5) }))).toEqual(['4B cpu'])
    expect(
      chain(
        facts({
          hardwareClass: 'dgpu',
          gpu: vulkan(16, 12),
          allowSmallFallback: false,
        }),
      ),
    ).toEqual(['4B gpu', '4B cpu'])
  })

  it('Windows shared cap exceeded drops 4B on the igpu', () => {
    const input = facts({
      hardwareClass: 'igpu',
      gpu: vulkan(32, 32),
      host: host(32, 20),
      sharedGpuCapBytes: 16 * GIB,
      sharedGpuUsedBytes: 12 * GIB,
    })
    expect(chain(input)).toEqual(['4B cpu', '0.6B gpu', '0.6B cpu'])
  })

  it('a known shared cap with unknown usage rejects igpu gpu placements', () => {
    const input = facts({
      hardwareClass: 'igpu',
      gpu: vulkan(32, 32),
      sharedGpuCapBytes: 16 * GIB,
    })
    expect(chain(input)).toEqual(['4B cpu', '0.6B cpu'])
  })
})
