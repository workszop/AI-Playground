/**
 * Kids-safe image filter check. Presets and the SafetyChecker node files are
 * copied to a folder every user can write to, so each run verifies what is
 * actually sent to ComfyUI: every saved still image comes straight out of a
 * SafetyChecker whose threshold is at most IMAGE_NSFW_THRESHOLD, and the node
 * code ComfyUI loads is the code shipped inside the app.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ComfyUIApiWorkflow } from '@/lib/presetSchemas'
import SAFETY_NODE_PY from '../../../comfyui-deps/custom_nodes/SafetyChecker/nodes.py?raw'
import SAFETY_NODE_INIT from '../../../comfyui-deps/custom_nodes/SafetyChecker/__init__.py?raw'

/** Highest NSFW score threshold allowed (locked preset strength 0.6). */
export const IMAGE_NSFW_THRESHOLD = 0.4

export const IMAGE_FILTER_MISSING_MESSAGE =
  'Filtr obrazów jest wyłączony albo zmieniony, więc obraz nie został wygenerowany.\n\n' +
  'The image safety filter is missing or changed, so no image was generated.'

const SAFETY_NODE_CLASS = 'SafetyChecker'
const SAFETY_NODE_DIR = 'SafetyChecker'
const SAFETY_NODE_FILES: Record<string, string> = {
  'nodes.py': SAFETY_NODE_PY,
  '__init__.py': SAFETY_NODE_INIT,
}
// Float rounding: 1 - 0.6 is 0.4 in doubles, but a written 0.4 must never fail.
const THRESHOLD_EPSILON = 1e-9

type WorkflowNode = { class_type?: unknown; inputs?: Record<string, unknown> }

function nodeOf(workflow: ComfyUIApiWorkflow, id: unknown): WorkflowNode | undefined {
  return typeof id === 'string' || typeof id === 'number'
    ? (workflow[String(id)] as WorkflowNode | undefined)
    : undefined
}

function isLink(value: unknown): value is [string | number, number] {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'number'
}

/** The threshold a SafetyChecker node will use: a number, or `a - b` from the presets' strength node. */
export function safetyThreshold(
  workflow: ComfyUIApiWorkflow,
  node: WorkflowNode,
): number | undefined {
  const threshold = node.inputs?.threshold
  if (typeof threshold === 'number') return threshold
  if (!isLink(threshold) || threshold[1] !== 0) return undefined
  const source = nodeOf(workflow, threshold[0])
  const { op, a, b } = source?.inputs ?? {}
  if (source?.class_type !== 'CM_FloatBinaryOperation' || op !== 'Sub') return undefined
  return typeof a === 'number' && typeof b === 'number' ? a - b : undefined
}

function isStrictSafetyChecker(workflow: ComfyUIApiWorkflow, node: WorkflowNode | undefined) {
  if (node?.class_type !== SAFETY_NODE_CLASS) return false
  const threshold = safetyThreshold(workflow, node)
  return threshold !== undefined && threshold <= IMAGE_NSFW_THRESHOLD + THRESHOLD_EPSILON
}

/** Ids of the nodes whose `images` come straight from a SafetyChecker's image output. */
export function checkedImageOutputs(workflow: ComfyUIApiWorkflow): Set<string> {
  const checked = new Set<string>()
  for (const [id, node] of Object.entries(workflow) as [string, WorkflowNode][]) {
    const images = node.inputs?.images
    if (!isLink(images) || images[1] !== 0) continue
    if (isStrictSafetyChecker(workflow, nodeOf(workflow, images[0]))) checked.add(id)
  }
  return checked
}

/**
 * Ids of the nodes that write images to disk: every `*SaveImage*`, and in a
 * still-image workflow every node that takes `images` and feeds nothing else
 * (savers and previews of any class). Video presets are unfiltered by design,
 * and their output node takes the frames as `images`.
 */
function imageSinks(workflow: ComfyUIApiWorkflow, mediaType: string | undefined): Set<string> {
  const consumed = new Set<string>()
  for (const node of Object.values(workflow) as WorkflowNode[]) {
    for (const value of Object.values(node.inputs ?? {})) {
      if (isLink(value)) consumed.add(String(value[0]))
    }
  }
  const sinks = new Set<string>()
  for (const [id, node] of Object.entries(workflow) as [string, WorkflowNode][]) {
    const saver = typeof node.class_type === 'string' && node.class_type.includes('SaveImage')
    const terminalImages = mediaType !== 'video' && isLink(node.inputs?.images) && !consumed.has(id)
    if (saver || terminalImages) sinks.add(id)
  }
  return sinks
}

/** Why a workflow may not run in the kids-safe build, or null when its image filter is intact. */
export function imageFilterProblem(
  workflow: ComfyUIApiWorkflow,
  mediaType: string | undefined,
): string | null {
  const nodes = Object.entries(workflow) as [string, WorkflowNode][]
  for (const [id, node] of nodes) {
    if (node.class_type === SAFETY_NODE_CLASS && !isStrictSafetyChecker(workflow, node)) {
      return `SafetyChecker node ${id} has a threshold above ${IMAGE_NSFW_THRESHOLD}`
    }
  }
  const checked = checkedImageOutputs(workflow)
  for (const id of imageSinks(workflow, mediaType)) {
    if (!checked.has(id))
      return `${String(workflow[id]?.class_type)} node ${id} is not fed by a SafetyChecker`
  }
  if (mediaType === 'image' && checked.size === 0) return 'no image output passes a SafetyChecker'
  return null
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')

/**
 * Rewrites the SafetyChecker node files in a ComfyUI install that differ from
 * the shipped ones. Resolves true when something was rewritten, so a running
 * ComfyUI (which has the old code loaded) must be restarted.
 */
export async function restoreSafetyCheckerNode(comfyDir: string): Promise<boolean> {
  const customNodes = path.join(comfyDir, 'custom_nodes')
  try {
    await fs.access(customNodes)
  } catch {
    return false // ComfyUI is not installed yet; its setup copies the node.
  }
  const nodeDir = path.join(customNodes, SAFETY_NODE_DIR)
  let restored = false
  for (const [name, shipped] of Object.entries(SAFETY_NODE_FILES)) {
    const file = path.join(nodeDir, name)
    const current = await fs.readFile(file, 'utf-8').catch(() => null)
    if (current !== null && sameText(current, shipped)) continue
    await fs.mkdir(nodeDir, { recursive: true })
    await fs.writeFile(file, shipped, 'utf-8')
    restored = true
  }
  return restored
}
