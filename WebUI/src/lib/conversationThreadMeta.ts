import { isRemovedChatPresetName } from './presetSchemas'
import type { ConversationThreadMeta, DesktopThreadMeta } from '@/types/conversationIpc'

/** Threads held with a removed preset, or by the removed remote chat, reopen as desktop chats. */
export function normalizeThreadMeta(meta: ConversationThreadMeta | null): DesktopThreadMeta | null {
  if (!meta) return null
  return {
    ...meta,
    presetName: isRemovedChatPresetName(meta.presetName) ? '' : meta.presetName,
    kind: 'main',
  }
}
