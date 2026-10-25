// Model-download helpers shared by the desktop dialog and its cancellation cleanup.

import { aipgFetch } from '@/lib/loopbackAuth'
import { SSEProcessor } from '@/assets/js/sseProcessor'

export type ModelMeta = DownloadModelParam & {
  size: string
  gated: boolean
  accessGranted: boolean
}

export type ModelDownloadProgress = {
  repoId: string
  /** Current file progress, 0-100. */
  percent: number
  /** Overall task progress across all models, 0-100. */
  taskPercent: number
  completed: number
  total: number
  downloadSize?: string
  totalSize?: string
  speed?: string
}

export type ModelDownloadErrorType =
  | 'not_enough_disk_space'
  | 'repositories_not_found'
  | 'download_exception'
  | 'runtime_error'
  | 'unknown_exception'

export type ModelDownloadError = {
  errType: ModelDownloadErrorType
  retryable: boolean
  /** English fallback message; callers may localize off `errType` instead. */
  message: string
  requiresSpace?: string
  freeSpace?: string
}

export type ModelDownloadCallbacks = {
  onProgress?: (_progress: ModelDownloadProgress) => void
  onModelCompleted?: (_repoId: string) => void
  onError?: (_error: ModelDownloadError) => void
}

export type ModelDownloadOptions = {
  apiHost: string
  hfToken?: string
  signal?: AbortSignal
} & ModelDownloadCallbacks

/** Fetch size, gated and access-granted metadata for a list of models. */
export async function fetchModelMeta(
  list: DownloadModelParam[],
  opts: { apiHost: string; hfToken?: string },
): Promise<ModelMeta[]> {
  const jsonHeaders = { 'Content-Type': 'application/json' }
  const sizeResponse = await aipgFetch(`${opts.apiHost}/api/getModelSize`, {
    method: 'POST',
    body: JSON.stringify(list),
    headers: jsonHeaders,
  })
  const gatedResponse = await aipgFetch(`${opts.apiHost}/api/isModelGated`, {
    method: 'POST',
    body: JSON.stringify([list, opts.hfToken]),
    headers: jsonHeaders,
  })
  const accessResponse = await aipgFetch(`${opts.apiHost}/api/isAccessGranted`, {
    method: 'POST',
    body: JSON.stringify([list, opts.hfToken]),
    headers: jsonHeaders,
  })
  const sizeData = (await sizeResponse.json()) as ApiResponse & { sizeList: StringKV }
  const gatedData = (await gatedResponse.json()) as ApiResponse & {
    gatedList: Record<string, boolean>
  }
  const accessData = (await accessResponse.json()) as ApiResponse & {
    accessList: Record<string, boolean>
  }
  return list.map((item) => ({
    ...item,
    size: sizeData.sizeList[`${item.repo_id}_${item.type}`] || '',
    gated: gatedData.gatedList[item.repo_id] || false,
    accessGranted: accessData.accessList[item.repo_id] || false,
  }))
}

function mapDownloadError(data: LLMOutCallback & { type: 'error' }): ModelDownloadError {
  switch (data.err_type) {
    case 'not_enough_disk_space':
      return {
        errType: 'not_enough_disk_space',
        retryable: false,
        message: `Not enough disk space (requires ${data.requires_space}, ${data.free_space} free).`,
        requiresSpace: data.requires_space,
        freeSpace: data.free_space,
      }
    case 'repositories_not_found':
      return {
        errType: 'repositories_not_found',
        retryable: false,
        message: 'The model repository could not be found.',
      }
    case 'download_exception':
      return {
        errType: 'download_exception',
        retryable: true,
        message: 'The download failed. It can be resumed.',
      }
    case 'runtime_error':
      return { errType: 'runtime_error', retryable: false, message: 'A runtime error occurred.' }
    default:
      return {
        errType: 'unknown_exception',
        retryable: false,
        message: 'An unknown error occurred during download.',
      }
  }
}

/**
 * Stream a model download from the AI Playground backend. Resolves once every
 * model in `list` is downloaded, rejects on error or abort. Progress and errors
 * are surfaced through the optional callbacks so each caller can render them in
 * its own idiom (desktop dialog UI vs. remote channel text).
 */
export function runModelDownload(
  list: DownloadModelParam[],
  opts: ModelDownloadOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const total = list.length
    let completeCount = 0
    let settled = false
    let settling = false
    let stopPromise: Promise<void> | undefined

    const stopDownload = (): Promise<void> => {
      stopPromise ??= aipgFetch(`${opts.apiHost}/api/stopDownloadModel`)
        .then(() => undefined)
        .catch(() => {})
      return stopPromise
    }

    const cleanup = () => opts.signal?.removeEventListener('abort', onAbort)
    const settle = (done: () => void) => {
      if (settled || settling) return
      settling = true
      const complete = () => {
        settled = true
        cleanup()
        done()
      }
      if (opts.signal?.aborted) void stopDownload().then(complete, complete)
      else complete()
    }

    const finish = () => {
      settle(resolve)
    }
    const fail = (error: Error) => {
      settle(() => reject(error))
    }

    if (opts.signal?.aborted) {
      settled = true
      reject(new Error('The model download was cancelled.'))
      return
    }

    const onAbort = () => {
      void stopDownload()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const taskPercent = () => (total > 0 ? Math.round((completeCount / total) * 1000) / 10 : 0)

    const onLine = (line: string) => {
      if (settled || settling || opts.signal?.aborted) return
      if (!line.startsWith('data:')) return
      let data: LLMOutCallback
      try {
        data = JSON.parse(line.slice(5)) as LLMOutCallback
      } catch {
        return
      }
      switch (data.type) {
        case 'download_model_progress':
          opts.onProgress?.({
            repoId: data.repo_id,
            percent: data.percent,
            taskPercent: taskPercent(),
            completed: completeCount,
            total,
            downloadSize: data.download_size,
            totalSize: data.total_size,
            speed: data.speed,
          })
          break
        case 'download_model_completed':
          completeCount++
          opts.onModelCompleted?.(data.repo_id)
          opts.onProgress?.({
            repoId: data.repo_id,
            percent: 100,
            taskPercent: taskPercent(),
            completed: completeCount,
            total,
          })
          if (completeCount >= total) finish()
          break
        case 'allComplete':
          finish()
          break
        case 'error': {
          const detail = mapDownloadError(data)
          opts.onError?.(detail)
          void stopDownload()
          fail(new Error(detail.message))
          break
        }
      }
    }

    aipgFetch(`${opts.apiHost}/api/downloadModel`, {
      method: 'POST',
      body: JSON.stringify({ data: list }),
      headers: {
        'Content-Type': 'application/json',
        ...(opts.hfToken ? { Authorization: `Bearer ${opts.hfToken}` } : {}),
      },
      signal: opts.signal,
    })
      .then((response) => new SSEProcessor(response.body!.getReader(), onLine, undefined).start())
      // Stream closed without an explicit allComplete (some servers just end):
      // treat a clean close as success so we don't hang.
      .then(() => finish())
      .catch((ex) => fail(ex instanceof Error ? ex : new Error(String(ex))))
  })
}
