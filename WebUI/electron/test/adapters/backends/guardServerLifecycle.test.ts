import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GuardPlacement } from '../../../safety/guardPlacement'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  net: {},
}))

const mocks = vi.hoisted(() => ({
  port: 0,
  child: null as unknown as FakeChild,
  spawnBackend: vi.fn(),
  terminateProcessTree: vi.fn(),
  waitForServerReadyOrThrow: vi.fn(),
}))

vi.mock('get-port', () => ({
  default: async () => mocks.port,
  portNumbers: () => [],
}))

vi.mock('../../../adapters/install/processLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../adapters/install/processLifecycle')>()
  mocks.waitForServerReadyOrThrow.mockImplementation(actual.waitForServerReadyOrThrow)
  return {
    ...actual,
    spawnBackend: mocks.spawnBackend,
    terminateProcessTree: mocks.terminateProcessTree,
    waitForServerReadyOrThrow: mocks.waitForServerReadyOrThrow,
  }
})

const { LlamaCppBackendService } = await import('../../../adapters/backends/llamaCppBackendService')

/** Enough of a llama-server child for the service: output pipes, exit, a pid. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  print(text: string) {
    this.stdout.emit('data', Buffer.from(text))
  }
  exit(code: number) {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

type GuardService = {
  startLlamaGuardServer(modelPath: string, placement: GuardPlacement): Promise<{ isReady: boolean }>
  stopChatServersForMedia(options: { keepGuard: boolean }): Promise<void>
  stopGuardServer(): Promise<void>
  guardPlacement(): GuardPlacement | null
  currentStatus: string
  llamaGuardProcess: unknown
}

const CPU_GUARD: GuardPlacement = {
  model: '4B',
  device: { kind: 'cpu' },
  threads: 4,
  batchThreads: 8,
  stopForMedia: false,
}

// The constructor reads and writes the install tree; these tests only need the server plumbing.
function guardService(): GuardService {
  const service = Object.create(LlamaCppBackendService.prototype)
  Object.assign(service, {
    name: 'llamacpp-backend',
    appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceDir: '/tmp/llama-guard-test',
    llamaCppBuildVariant: 'standard',
    llamaLlmProcess: null,
    llamaEmbeddingProcess: null,
    llamaGuardProcess: null,
    guardServerStarting: null,
    currentStatus: 'running',
    updateStatus: vi.fn(),
  })
  return service as GuardService
}

function runningGuard(service: GuardService): FakeChild {
  const child = new FakeChild()
  service.llamaGuardProcess = {
    process: child,
    port: 39300,
    modelPath: '/m/guard.gguf',
    modelRepoId: 'guard.gguf',
    type: 'guard',
    placement: CPU_GUARD,
    isReady: true,
  }
  return child
}

const terminatedChildren = () => mocks.terminateProcessTree.mock.calls.map(([proc]) => proc)

describe('guard server lifecycle', () => {
  let server: Server
  let healthStatuses: number[]
  let healthHits: number
  let onHealth: (() => void) | null

  beforeAll(async () => {
    server = createServer((_req, res) => {
      onHealth?.()
      const status = healthStatuses[Math.min(healthHits, healthStatuses.length - 1)]
      healthHits++
      res.writeHead(status).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    mocks.port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    healthHits = 0
    healthStatuses = [503, 200]
    onHealth = null
    mocks.spawnBackend.mockImplementation(() => {
      mocks.child = new FakeChild()
      return mocks.child as unknown as ChildProcess
    })
    mocks.terminateProcessTree.mockImplementation(async (proc: FakeChild) => {
      if (proc.exitCode === null) proc.exit(0)
    })
  })

  afterEach(() => {
    mocks.spawnBackend.mockReset()
    mocks.terminateProcessTree.mockReset()
  })

  it('becomes ready once /health answers 200 although the server printed its banner', async () => {
    const service = guardService()
    // llama-server logs from the first moment and answers 503 while the model loads.
    onHealth = () => mocks.child.print('main: loading model\nsrv  init: initializing slots\n')

    const started = await service.startLlamaGuardServer('/m/guard.gguf', CPU_GUARD)

    expect(started.isReady).toBe(true)
    expect(healthHits).toBe(2)
    expect(service.guardPlacement()).toEqual(CPU_GUARD)
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled()
  })

  it('reports the last output and kills the child when it exits during startup', async () => {
    const service = guardService()
    healthStatuses = [503]
    // Dies between two health polls, as an abort during model load does.
    onHealth = () => {
      onHealth = null
      setTimeout(() => {
        mocks.child.print('error: failed to load model\n')
        mocks.child.exit(1)
      }, 50)
    }

    await expect(service.startLlamaGuardServer('/m/guard.gguf', CPU_GUARD)).rejects.toThrow(
      /failed to load model/,
    )
    expect(terminatedChildren()).toContain(mocks.child)
    expect(service.guardPlacement()).toBeNull()
  })

  it('kills the child when it never becomes ready', async () => {
    const service = guardService()
    mocks.waitForServerReadyOrThrow.mockRejectedValueOnce(
      new Error('Server failed to start within 120 seconds'),
    )

    await expect(service.startLlamaGuardServer('/m/guard.gguf', CPU_GUARD)).rejects.toThrow(
      'Server failed to start within 120 seconds',
    )
    expect(terminatedChildren()).toEqual([mocks.child])
    expect(mocks.child.exitCode).not.toBeNull()
  })

  it('stopGuardServer kills a guard that is still starting', async () => {
    const service = guardService()
    healthStatuses = [503]
    const starting = service.startLlamaGuardServer('/m/guard.gguf', CPU_GUARD)
    const outcome = starting.then(
      () => 'ready',
      () => 'failed',
    )
    await vi.waitFor(() => expect(healthHits).toBeGreaterThan(0))

    await service.stopGuardServer()

    expect(await outcome).toBe('failed')
    expect(terminatedChildren()).toContain(mocks.child)
    expect(service.guardPlacement()).toBeNull()
  })

  it('stopGuardServer stops a guard kept through a media stop', async () => {
    const service = guardService()
    const guard = runningGuard(service)

    await service.stopChatServersForMedia({ keepGuard: true })
    expect(service.currentStatus).toBe('stopped')
    expect(terminatedChildren()).not.toContain(guard)
    expect(service.guardPlacement()).toEqual(CPU_GUARD)

    await service.stopGuardServer()
    expect(terminatedChildren()).toEqual([guard])
    expect(service.guardPlacement()).toBeNull()
  })

  it('a media stop on a service that is not running leaves its status alone', async () => {
    const service = guardService()
    service.currentStatus = 'notYetStarted'
    const guard = runningGuard(service)

    await service.stopChatServersForMedia({ keepGuard: true })
    expect(service.currentStatus).toBe('notYetStarted')
    expect(terminatedChildren()).toEqual([])
    expect(service.guardPlacement()).toEqual(CPU_GUARD)

    await service.stopChatServersForMedia({ keepGuard: false })
    expect(service.currentStatus).toBe('notYetStarted')
    expect(terminatedChildren()).toEqual([guard])
    expect(service.guardPlacement()).toBeNull()
  })
})
