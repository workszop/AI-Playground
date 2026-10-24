import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type CpuTopology = {
  performanceCores?: number
  efficiencyCores?: number
  lowPowerCores?: number
  logicalCpus: number
}

const MIN_BATCH_THREADS = 4
const MAX_BATCH_THREADS = 8
const MAX_THREADS = 4

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// ─── Thread counts ───

export function cpuThreadCounts(topology: CpuTopology): { threads: number; batchThreads: number } {
  const { performanceCores, efficiencyCores, logicalCpus } = topology
  const known = performanceCores !== undefined || efficiencyCores !== undefined
  const rawBatch = known
    ? (performanceCores ?? 0) + (efficiencyCores ?? 0)
    : Math.floor(logicalCpus / 2)
  const batchThreads = clamp(rawBatch, MIN_BATCH_THREADS, MAX_BATCH_THREADS)
  return { threads: Math.min(MAX_THREADS, batchThreads), batchThreads }
}

// ─── Sysfs reading ───

export function parseCpuList(list: string): number[] {
  const cpus: number[] = []
  for (const part of list.trim().split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [startText, endText] = trimmed.split('-')
    const start = Number(startText)
    const end = endText === undefined ? start : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue
    for (let cpu = start; cpu <= end; cpu++) cpus.push(cpu)
  }
  return cpus
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readCpuSet(file: string): number[] | undefined {
  const text = readText(file)
  return text === undefined ? undefined : parseCpuList(text)
}

function cpuDir(sysRoot: string, cpu: number) {
  return path.join(sysRoot, 'devices/system/cpu', `cpu${cpu}`)
}

function physicalCoreKeys(sysRoot: string, cpus: number[]): Set<string> | undefined {
  const keys = new Set<string>()
  for (const cpu of cpus) {
    const siblings = readText(path.join(cpuDir(sysRoot, cpu), 'topology/core_cpus_list'))
    if (siblings === undefined) return undefined
    keys.add(siblings.trim())
  }
  return keys
}

function hasL3(sysRoot: string, cpu: number) {
  return fs.existsSync(path.join(cpuDir(sysRoot, cpu), 'cache/index3'))
}

function readLinuxTopology(sysRoot: string): Omit<CpuTopology, 'logicalCpus'> {
  const performanceCpus = readCpuSet(path.join(sysRoot, 'devices/cpu_core/cpus'))
  const atomCpus = readCpuSet(path.join(sysRoot, 'devices/cpu_atom/cpus'))
  if (performanceCpus && atomCpus) {
    const efficiencyCpus = atomCpus.filter((cpu) => hasL3(sysRoot, cpu))
    const lowPowerCpus = atomCpus.filter((cpu) => !hasL3(sysRoot, cpu))
    const performance = physicalCoreKeys(sysRoot, performanceCpus)
    const efficiency = physicalCoreKeys(sysRoot, efficiencyCpus)
    const lowPower = physicalCoreKeys(sysRoot, lowPowerCpus)
    if (!performance || !efficiency || !lowPower) return {}
    return {
      performanceCores: performance.size,
      efficiencyCores: efficiency.size,
      lowPowerCores: lowPower.size,
    }
  }
  const online = readCpuSet(path.join(sysRoot, 'devices/system/cpu/online'))
  if (!online) return {}
  const all = physicalCoreKeys(sysRoot, online)
  return all ? { performanceCores: all.size } : {}
}

export function readCpuTopology(sysRoot = '/sys'): CpuTopology {
  const logicalCpus = os.cpus().length || 1
  if (process.platform !== 'linux') return { logicalCpus }
  try {
    return { ...readLinuxTopology(sysRoot), logicalCpus }
  } catch {
    return { logicalCpus }
  }
}
