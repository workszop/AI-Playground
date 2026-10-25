<template>
  <div v-if="pending" class="flex items-start gap-3" role="alertdialog" aria-live="polite">
    <img v-if="withAvatar" class="size-6 shrink-0" src="../assets/svg/ai-icon.svg" />
    <div
      class="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border border-border bg-card/60 p-4"
      :class="withAvatar ? 'mt-0.5' : ''"
    >
      <div class="flex items-center gap-2 text-sm font-medium text-foreground">
        <QuestionMarkCircleIcon class="size-4 shrink-0 text-primary" />
        <span class="truncate">{{ pending.title }}</span>
      </div>
      <MarkdownRenderer :content="pending.summaryMarkdown" />
      <div class="flex items-center gap-3">
        <button
          class="rounded bg-primary px-4 py-1 text-sm text-foreground transition-opacity hover:opacity-90"
          @click="decide(true)"
        >
          {{ i18nState.COM_CONFIRM }}
        </button>
        <button
          class="rounded bg-muted px-4 py-1 text-sm text-foreground transition-opacity hover:opacity-90"
          @click="decide(false)"
        >
          {{ i18nState.COM_CANCEL }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { QuestionMarkCircleIcon } from '@heroicons/vue/24/outline'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useI18N } from '@/assets/js/store/i18n'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'

const props = withDefaults(
  defineProps<{
    conversationKey: string
    // Render a leading AI avatar (used when shown as a standalone turn, before
    // the assistant message bubble exists). Mirrors ChatActivityIndicator.
    withAvatar?: boolean
  }>(),
  { withAvatar: false },
)

const confirmations = useConfirmations()
const i18nState = useI18N().state

const pending = computed(() => confirmations.forConversation(props.conversationKey))

function decide(answer: boolean) {
  if (pending.value) confirmations.resolve(pending.value.id, answer)
}
</script>
