import type { GpuSample } from '@/types/computeMetrics.ts'
import {
  bestNameMatch,
  categorizeDevice,
  rankDevicesByCategory,
  type DeviceCategory,
  type ReferenceAccelerator,
} from '../adapters/hardware/deviceArch.ts'
import type { CpuTopology } from './cpuTopology'
import type { GuardFacts } from './guardPlacement'
import { KIDS_GUARD_ALLOW_SMALL_FALLBACK } from './kidsGuard'

export type GuardFactsDeps = {
  /** Devices llama.cpp listed, under the llama.cpp service's own ids, with their memory when printed. */
  llamaDevices(): { id: string; name: string; totalBytes?: number; freeBytes?: number }[]
  /** The service id of the device the user selected for chat. */
  selectedDeviceId(): string | undefined
  /** Physically detected GPUs, which tell discrete from integrated. */
  gpuReference(): Promise<ReferenceAccelerator[]>
  hostMemory(): { memUsedMiB: number; memTotalMiB: number }
  /** Latest live GPU samples (WDDM on Windows). */
  gpuSamples(): GpuSample[]
  platform(): NodeJS.Platform
  cpuTopology(): CpuTopology
}

const MIB = 1024 ** 2
const GPU_CATEGORIES: ReadonlySet<DeviceCategory> = new Set(['dgpu', 'igpu'])
// GPUs carry a numeric index after the backend prefix is stripped; CPU and BLAS entries do not.
const GPU_DEVICE_ID = /^\d+$/

const mibToBytes = (mib: number | undefined) => (mib === undefined ? undefined : mib * MIB)

async function referenceOrNone(deps: GuardFactsDeps): Promise<ReferenceAccelerator[]> {
  try {
    return await deps.gpuReference()
  } catch {
    return []
  }
}

/** Windows iGPU allocation cap (dedicated + shared) and its use, from the WDDM sample matching `name`. */
function sharedGpuMemory(deps: GuardFactsDeps, name: string) {
  const samples = deps.gpuSamples().filter((sample) => sample.sharedTotalMiB !== undefined)
  const sample = bestNameMatch(name, samples)
  if (!sample) return {}
  const used = [sample.dedicatedUsedMiB, sample.sharedUsedMiB].filter(
    (mib): mib is number => mib !== undefined,
  )
  return {
    sharedGpuCapBytes: mibToBytes((sample.dedicatedTotalMiB ?? 0) + (sample.sharedTotalMiB ?? 0)),
    sharedGpuUsedBytes: used.length > 0 ? mibToBytes(used.reduce((a, b) => a + b, 0)) : undefined,
  }
}

/** Facts the guard placement planner needs, read from the app's existing detection and metrics. */
export async function collectGuardFacts(deps: GuardFactsDeps): Promise<GuardFacts> {
  const reference = await referenceOrNone(deps)
  const gpus = deps
    .llamaDevices()
    .filter(
      (device) =>
        GPU_DEVICE_ID.test(device.id) && GPU_CATEGORIES.has(categorizeDevice(device, reference)),
    )
  const selectedId = deps.selectedDeviceId()
  const gpu =
    gpus.find((device) => device.id === selectedId) ?? rankDevicesByCategory(gpus, reference)[0]
  const { memUsedMiB, memTotalMiB } = deps.hostMemory()
  const base = {
    host: { totalBytes: mibToBytes(memTotalMiB), freeBytes: mibToBytes(memTotalMiB - memUsedMiB) },
    cpu: deps.cpuTopology(),
    allowSmallFallback: KIDS_GUARD_ALLOW_SMALL_FALLBACK,
  }
  if (!gpu) return { hardwareClass: 'cpu-only', ...base }
  const hardwareClass = categorizeDevice(gpu, reference) === 'dgpu' ? 'dgpu' : 'igpu'
  return {
    hardwareClass,
    gpu: { llamaDeviceId: gpu.id, totalBytes: gpu.totalBytes, freeBytes: gpu.freeBytes },
    ...base,
    ...(hardwareClass === 'igpu' && deps.platform() === 'win32'
      ? sharedGpuMemory(deps, gpu.name)
      : {}),
  }
}
