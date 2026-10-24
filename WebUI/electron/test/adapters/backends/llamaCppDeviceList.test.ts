import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  net: {},
}))

const { parseLlamaCppDeviceList } =
  await import('../../../adapters/backends/llamaCppBackendService.ts')

const MIB = 1024 ** 2

describe('parseLlamaCppDeviceList', () => {
  it('keeps each device memory tuple under the service device id', () => {
    const output = [
      'load_backend: loaded Vulkan backend from ggml-vulkan.dll',
      'Available devices:',
      '  Vulkan0: Intel(R) Arc(TM) Graphics (16052 MiB, 15210 MiB free)',
      '  Vulkan1: Intel(R) Arc(TM) B580 Graphics (12216 MiB, 11800 MiB free)',
      'build: 6500 (abc123) with MSVC',
    ].join('\n')
    expect(parseLlamaCppDeviceList(output)).toEqual([
      {
        id: '0',
        name: 'Intel(R) Arc(TM) Graphics',
        totalBytes: 16052 * MIB,
        freeBytes: 15210 * MIB,
      },
      {
        id: '1',
        name: 'Intel(R) Arc(TM) B580 Graphics',
        totalBytes: 12216 * MIB,
        freeBytes: 11800 * MIB,
      },
    ])
  })

  it('lists a device whose memory is not in MiB without memory numbers', () => {
    const output = 'Available devices:\n  BLAS: OpenBLAS (0 GiB, 0 GiB free)'
    expect(parseLlamaCppDeviceList(output)).toEqual([{ id: 'BLAS', name: 'OpenBLAS' }])
  })

  it('finds nothing before the devices header or in a CPU-only build', () => {
    expect(parseLlamaCppDeviceList('Vulkan0: Not a device (1 MiB, 1 MiB free)')).toEqual([])
    expect(parseLlamaCppDeviceList('Available devices:\n')).toEqual([])
  })
})
