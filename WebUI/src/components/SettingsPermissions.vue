<template>
  <DemoModeBlocker>
    <div class="flex flex-col gap-3 pt-4">
      <SettingsHeading>{{ languages.SETTINGS_PERMISSIONS }}</SettingsHeading>
      <div class="pl-2 pt-2 flex flex-col gap-4">
        <div class="border-t border-white/10 pt-3 flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <SettingsHeading sub>{{ languages.SETTINGS_PERMISSIONS_REMEMBERED }}</SettingsHeading>
          </div>
          <div v-if="rememberedGrants.length" class="flex flex-col gap-2">
            <div
              v-for="grant in rememberedGrants"
              :key="grant.key"
              class="flex justify-between pr-4 items-center gap-4"
            >
              <span class="text-sm">{{ labelFor(grant) }}</span>
              <Button variant="outline" size="sm" @click="grants.revoke(grant.key)">
                {{ languages.SETTINGS_PERMISSIONS_REVOKE }}
              </Button>
            </div>
          </div>
          <p v-else class="text-xs opacity-60">{{ languages.SETTINGS_PERMISSIONS_EMPTY }}</p>
        </div>
      </div>
    </div>
  </DemoModeBlocker>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  usePermissionGrants,
  VRAM_WARNING_GRANT_PREFIX,
  type PermissionGrant,
} from '@/assets/js/store/permissionGrants'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import SettingsHeading from '@/components/SettingsHeading.vue'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'

const grants = usePermissionGrants()
const i18nState = useI18N().state
const languages = i18nState

const rememberedGrants = computed<PermissionGrant[]>(() =>
  grants.list.filter((grant) => grant.origin === 'remember'),
)

function labelFor(grant: PermissionGrant): string {
  if (grant.key.startsWith(VRAM_WARNING_GRANT_PREFIX)) {
    return (languages.SETTINGS_PERMISSIONS_VRAM_LABEL ?? '').replace(
      '{preset}',
      grant.key.slice(VRAM_WARNING_GRANT_PREFIX.length),
    )
  }
  return grant.key
}
</script>
