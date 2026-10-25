/**
 * Which components the Setup Wizard pre-selects for install.
 *
 * Pure on purpose: the wizard store gathers live service info, this decides. The
 * policy is "every optional component that is available and not switched off".
 */

/**
 * Nested under Core Services in the wizard rather than offered as peers: the
 * speech sidecars are runtimes the core experience depends on, and their weights
 * download on first use. They stay individually toggleable behind the Core
 * Services disclosure so a failed one can be skipped, repaired or reinstalled.
 */
export const CORE_DEPENDENT_BACKENDS = [
  'qwen3-tts-backend',
  'whisper-backend',
] as const satisfies readonly BackendServiceName[]

export function isCoreDependentBackend(name: string): boolean {
  return (CORE_DEPENDENT_BACKENDS as readonly string[]).includes(name)
}

export type SeedCandidate = {
  serviceName: BackendServiceName
  isRequired: boolean
  isSetUp: boolean
  availableInProductMode: boolean
  /** The user switched it off before (persisted in settings.json). */
  userDisabled: boolean
  /** Fresh Phison machine: the aiDAPTIV+ row owns llama.cpp, so skip this one. */
  phisonOwnsLlamaCpp?: boolean
}

/**
 * The components a freshly-opened wizard should have enabled.
 *
 * Required components are omitted — they are always installed and their rows are
 * locked on, so carrying them in the selection would say nothing.
 */
export function selectDefaultInstalls(candidates: SeedCandidate[]): BackendServiceName[] {
  return candidates
    .filter((c) => {
      if (c.isRequired) return false
      if (!c.availableInProductMode) return false
      if (c.userDisabled) return false
      if (c.phisonOwnsLlamaCpp) return false
      return true
    })
    .map((c) => c.serviceName)
}
