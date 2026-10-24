import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cpuThreadCounts, parseCpuList, readCpuTopology } from '../../safety/cpuTopology'

const tempRoots: string[] = []

function makeSysfs(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysfs-'))
  tempRoots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return root
}

const cpuFile = (cpu: number, name: string) => `devices/system/cpu/cpu${cpu}/${name}`

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('parseCpuList', () => {
  it('parses ranges and singles', () => {
    expect(parseCpuList('0-3,8,10-11\n')).toEqual([0, 1, 2, 3, 8, 10, 11])
  })
  it('handles empty and malformed input', () => {
    expect(parseCpuList('')).toEqual([])
    expect(parseCpuList('x,3-1,5')).toEqual([5])
  })
})

describe('cpuThreadCounts', () => {
  it('excludes low-power cores on a 135U-like part', () => {
    const topology = { performanceCores: 2, efficiencyCores: 8, lowPowerCores: 2, logicalCpus: 14 }
    expect(cpuThreadCounts(topology)).toEqual({ threads: 4, batchThreads: 8 })
  })
  it('uses 4/4 for a 4-core non-hybrid CPU', () => {
    expect(cpuThreadCounts({ performanceCores: 4, logicalCpus: 8 })).toEqual({
      threads: 4,
      batchThreads: 4,
    })
  })
  it('halves logical CPUs when topology is unknown', () => {
    expect(cpuThreadCounts({ logicalCpus: 14 })).toEqual({ threads: 4, batchThreads: 7 })
  })
  it('clamps to [4, 8]', () => {
    expect(cpuThreadCounts({ logicalCpus: 2 }).batchThreads).toBe(4)
    expect(cpuThreadCounts({ performanceCores: 16, logicalCpus: 32 }).batchThreads).toBe(8)
  })
})

describe('readCpuTopology', () => {
  it('reads a hybrid CPU with a low-power island', () => {
    const files: Record<string, string> = {
      'devices/cpu_core/cpus': '0-3',
      'devices/cpu_atom/cpus': '4-7',
    }
    // P-cores 0-3 are two hyperthreaded cores, E-cores 4-5 have L3, 6-7 are low-power
    for (const cpu of [0, 1]) files[cpuFile(cpu, 'topology/core_cpus_list')] = '0-1'
    for (const cpu of [2, 3]) files[cpuFile(cpu, 'topology/core_cpus_list')] = '2-3'
    for (const cpu of [4, 5, 6, 7]) files[cpuFile(cpu, 'topology/core_cpus_list')] = String(cpu)
    for (const cpu of [4, 5]) files[cpuFile(cpu, 'cache/index3/level')] = '3'
    const topology = readCpuTopology(makeSysfs(files))
    expect(topology).toMatchObject({ performanceCores: 2, efficiencyCores: 2, lowPowerCores: 2 })
  })
  it('reads a non-hybrid CPU', () => {
    const files: Record<string, string> = { 'devices/system/cpu/online': '0-3' }
    for (const cpu of [0, 1]) files[cpuFile(cpu, 'topology/core_cpus_list')] = '0-1'
    for (const cpu of [2, 3]) files[cpuFile(cpu, 'topology/core_cpus_list')] = '2-3'
    const topology = readCpuTopology(makeSysfs(files))
    expect(topology.performanceCores).toBe(2)
    expect(topology.efficiencyCores).toBeUndefined()
  })
  it('never throws and leaves fields undefined on read errors', () => {
    const topology = readCpuTopology(path.join(os.tmpdir(), 'missing-sysfs-root'))
    expect(topology.performanceCores).toBeUndefined()
    expect(topology.logicalCpus).toBeGreaterThan(0)
  })
})
