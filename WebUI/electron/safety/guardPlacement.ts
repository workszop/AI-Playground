import { HOST_RESERVE_BYTES } from '../../src/lib/vram/fit'
import { cpuThreadCounts, type CpuTopology } from './cpuTopology'

export type GuardModelSize = '4B' | '0.6B'
export type GuardDevice = { kind: 'gpu'; llamaDeviceId: string } | { kind: 'cpu' }
export type GuardPlacement = {
  model: GuardModelSize
  device: GuardDevice
  threads: number
  batchThreads: number
  stopForMedia: boolean
}
export type HardwareClass = 'cpu-only' | 'igpu' | 'dgpu'
export type GuardFacts = {
  hardwareClass: HardwareClass
  /** The GPU the guard may use, by the llama.cpp service's own device id, when there is one. */
  gpu?: { llamaDeviceId: string; totalBytes?: number; freeBytes?: number }
  host: { totalBytes?: number; freeBytes?: number }
  /** Windows iGPU allocation cap (dedicated + shared), when known. */
  sharedGpuCapBytes?: number
  /** Bytes already used against that cap, when known. */
  sharedGpuUsedBytes?: number
  cpu: CpuTopology
  allowSmallFallback: boolean
}
export type GuardPlan = { chat: GuardPlacement[]; media: GuardPlacement[] }

// ─── Constants ───

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const FOOTPRINT_BYTES: Record<GuardModelSize, number> = {
  '4B': Math.round(3.6 * GIB),
  '0.6B': Math.round(1.4 * GIB),
}
const GPU_HEADROOM_BYTES = 512 * MIB
const LARGE_DGPU_BYTES = 8 * GIB
const SHARED_CAP_FRACTION = 0.9
const GPU_THREADS = 2

type Candidate = { model: GuardModelSize; onGpu: boolean }

const gpu = (model: GuardModelSize): Candidate => ({ model, onGpu: true })
const cpu = (model: GuardModelSize): Candidate => ({ model, onGpu: false })

// ─── Candidates ───

function candidateOrder(facts: GuardFacts): Candidate[] {
  if (facts.hardwareClass === 'cpu-only') return [cpu('4B'), cpu('0.6B')]
  const largeDgpu =
    facts.hardwareClass === 'dgpu' && (facts.gpu?.totalBytes ?? 0) > LARGE_DGPU_BYTES
  if (facts.hardwareClass === 'dgpu' && !largeDgpu) return [cpu('4B'), gpu('0.6B'), cpu('0.6B')]
  return [gpu('4B'), cpu('4B'), gpu('0.6B'), cpu('0.6B')]
}

function fitsHost(facts: GuardFacts, footprint: number) {
  const free = facts.host.freeBytes
  return free !== undefined && footprint <= free - HOST_RESERVE_BYTES
}

function fitsSharedCap(facts: GuardFacts, footprint: number) {
  if (facts.sharedGpuCapBytes === undefined) return true
  if (facts.sharedGpuUsedBytes === undefined) return false
  return facts.sharedGpuUsedBytes + footprint <= SHARED_CAP_FRACTION * facts.sharedGpuCapBytes
}

function fits(facts: GuardFacts, candidate: Candidate) {
  const footprint = FOOTPRINT_BYTES[candidate.model]
  if (!candidate.onGpu) return fitsHost(facts, footprint)
  if (facts.hardwareClass === 'dgpu') {
    const free = facts.gpu?.freeBytes
    return free !== undefined && footprint + GPU_HEADROOM_BYTES <= free
  }
  return fitsHost(facts, footprint) && fitsSharedCap(facts, footprint)
}

function toPlacement(facts: GuardFacts, candidate: Candidate): GuardPlacement {
  const stopForMedia = candidate.onGpu || facts.hardwareClass === 'igpu'
  if (candidate.onGpu && facts.gpu) {
    return {
      model: candidate.model,
      device: { kind: 'gpu', llamaDeviceId: facts.gpu.llamaDeviceId },
      threads: GPU_THREADS,
      batchThreads: GPU_THREADS,
      stopForMedia,
    }
  }
  return {
    model: candidate.model,
    device: { kind: 'cpu' },
    ...cpuThreadCounts(facts.cpu),
    stopForMedia,
  }
}

// ─── Planner ───

export function planGuardPlacements(facts: GuardFacts): GuardPlan {
  const candidates = candidateOrder(facts).filter(
    (candidate) =>
      (facts.allowSmallFallback || candidate.model !== '0.6B') && (!candidate.onGpu || facts.gpu),
  )
  const lastResort = candidates[candidates.length - 1]
  const chat = candidates
    .filter((candidate) => candidate === lastResort || fits(facts, candidate))
    .map((candidate) => toPlacement(facts, candidate))
  return { chat, media: chat.filter((placement) => !placement.stopForMedia) }
}
