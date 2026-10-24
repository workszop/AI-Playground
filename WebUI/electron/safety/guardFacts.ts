import type { GpuSample } from '@/types/computeMetrics.ts'
import {
  bestNameMatch,
  categorizeDevice,
  rankDevicesByCategory,
  type DeviceCategory,
  type ReferenceAccelerator,
} from '../adapters/hardware/deviceArch.ts'
import type { CpuTopology } from './cpuTopology'
import { GUARD_FOOTPRINT_BYTES, type GuardFacts, type GuardPlacement } from './guardPlacement'
import { KIDS_GUARD_ALLOW_SMALL_FALLBACK } from './kidsGuard'

export type GuardFactsDeps = {
  /** Devices llama.cpp listed, under the llama.cpp service's own ids, with their memory when printed. */
  llamaDevices(): { id: string; name: string; totalBytes?: number; freeBytes?: number }[]
  /** The service id of the device the user selected for chat. */
  selectedDeviceId(): string | undefined
  /** Physically detected GPUs, which tell discrete from integrated. */
  gpuReference(): Promise<ReferenceAccelerator[]>
  hostMemory(): { memUsedMiB: number; memTotalMiB: number }
  /** Latest live GPU samples (WDDM on Windows, vendor SMI tools elsewhere). */
  gpuSamples(): GpuSample[]
  platform(): NodeJS.Platform
  cpuTopology(): CpuTopology
  /** The placement of the guard server that is up now, whose memory the live numbers include. */
  runningGuard(): GuardPlacement | null
}

const MIB = 1024 ** 2
const GPU_CATEGORIES: ReadonlySet<DeviceCategory> = new Set(['dgpu', 'igpu'])
// GPUs carry a numeric index after the backend prefix is stripped; CPU and BLAS entries do not.
const GPU_DEVICE_ID = /^\d+$/

const mibToBytes = (mib: number | undefined) => (mib === undefined ? undefined : mib * MIB)
const sum = (values: (number | undefined)[]) => {
  const known = values.filter((value): value is number => value !== undefined)
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : undefined
}

/** Shares one in-flight call and keeps its result, but forgets a rejection so the next call retries. */
export function memoizeUntilRejected<T>(load: () => Promise<T>): () => Promise<T> {
  let memo: Promise<T> | null = null
  return () => {
    memo ??= load().catch((error) => {
      memo = null
      throw error
    })
    return memo
  }
}

async function referenceOrNone(deps: GuardFactsDeps): Promise<ReferenceAccelerator[]> {
  try {
    return await deps.gpuReference()
  } catch {
    return []
  }
}

/** Windows iGPU allocation cap (dedicated + shared) and its use, from the WDDM sample matching `name`. */
function sharedGpuMemory(samples: GpuSample[], name: string) {
  const sample = bestNameMatch(
    name,
    samples.filter((candidate) => candidate.sharedTotalMiB !== undefined),
  )
  // Unknown on Windows means does not fit: a zero cap with unknown use fails the shared-cap check.
  if (!sample) return { capBytes: 0, usedBytes: undefined }
  return {
    capBytes: mibToBytes((sample.dedicatedTotalMiB ?? 0) + (sample.sharedTotalMiB ?? 0)),
    usedBytes: mibToBytes(sum([sample.dedicatedUsedMiB, sample.sharedUsedMiB])),
  }
}

/** Live total and free memory of a discrete GPU from the sample matching `name`, when it has both. */
function liveGpuMemory(samples: GpuSample[], name: string) {
  const sample = bestNameMatch(name, samples)
  if (!sample) return undefined
  const total = sample.dedicatedTotalMiB ?? sample.memTotalMiB
  const used = sample.dedicatedTotalMiB !== undefined ? sample.dedicatedUsedMiB : sample.memUsedMiB
  if (total === undefined || used === undefined) return undefined
  return { totalBytes: total * MIB, freeBytes: Math.max(0, total - used) * MIB }
}

/**
 * Facts the guard placement planner needs, read from the app's existing detection and metrics.
 * Live numbers include a running guard, so its footprint is credited back: otherwise the guard
 * would crowd itself out and swap model or device on every check.
 */
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
  const discrete = !!gpu && categorizeDevice(gpu, reference) === 'dgpu'

  const running = deps.runningGuard()
  const footprint = running ? GUARD_FOOTPRINT_BYTES[running.model] : 0
  const runningOnGpu =
    !!gpu && running?.device.kind === 'gpu' && running.device.llamaDeviceId === gpu.id
  const hostCredit = running?.device.kind === 'cpu' || (runningOnGpu && !discrete) ? footprint : 0

  const { memUsedMiB, memTotalMiB } = deps.hostMemory()
  const hostTotal = memTotalMiB * MIB
  const base = {
    host: {
      totalBytes: hostTotal,
      freeBytes: Math.min(hostTotal, (memTotalMiB - memUsedMiB) * MIB + hostCredit),
    },
    cpu: deps.cpuTopology(),
    allowSmallFallback: KIDS_GUARD_ALLOW_SMALL_FALLBACK,
  }
  if (!gpu) return { hardwareClass: 'cpu-only', ...base }

  const samples = deps.gpuSamples()
  if (discrete) {
    // The --list-devices numbers date from detection, before any guard ran, so only live ones get the credit.
    const live = liveGpuMemory(samples, gpu.name)
    const memory = live
      ? { ...live, freeBytes: live.freeBytes + (runningOnGpu ? footprint : 0) }
      : { totalBytes: gpu.totalBytes, freeBytes: gpu.freeBytes }
    return { hardwareClass: 'dgpu', gpu: { llamaDeviceId: gpu.id, ...memory }, ...base }
  }
  const facts: GuardFacts = {
    hardwareClass: 'igpu',
    gpu: { llamaDeviceId: gpu.id, totalBytes: gpu.totalBytes, freeBytes: gpu.freeBytes },
    ...base,
  }
  if (deps.platform() !== 'win32') return facts
  const shared = sharedGpuMemory(samples, gpu.name)
  return {
    ...facts,
    sharedGpuCapBytes: shared.capBytes,
    sharedGpuUsedBytes:
      shared.usedBytes === undefined
        ? undefined
        : Math.max(0, shared.usedBytes - (runningOnGpu ? footprint : 0)),
  }
}
