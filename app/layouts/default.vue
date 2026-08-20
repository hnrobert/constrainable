<script setup lang="ts">
import type { Component } from 'vue'
import {
  Network,
  LayoutDashboard,
  CalendarDays,
  Radio,
  Users,
  UsersRound,
  Settings,
  Mail,
  ScrollText,
  LogOut,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-vue-next'

// Dashboard shell with a left vertical sidebar (mirrors verifier-gateway's
// hand-rolled sidebar layout). Nav is role-aware: both roles see Dashboard +
// Events; management pages are admin-only. The server middleware +
// requireAdmin are the real gates; this nav only hides unreachable routes.
const { user, logout } = useAuth()
const route = useRoute()
const isAdmin = computed(() => user.value?.role === 'admin')

// `useDark` toggles the `.dark` class on <html> and persists the choice under
// 'ci.theme' (read pre-paint by the no-FOUC head script). First visit follows
// the OS preference (mode 'auto').
const isDark = useDark({ storageKey: 'ci.theme' })
const sidebarOpen = ref(false)

interface NavItem {
  label: string
  to: string
  icon: Component
}

// The nav is split into two groups so the sidebar visually distinguishes what
// every user can reach (Dashboard, Events) from admin-only management pages —
// the admin group is shown under an "Administration" heading only for admins
// (mirrors verifier-gateway's section pattern). The server middleware +
// requireAdmin are the real gates; this only hides unreachable routes.
const generalNav: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Events', to: '/dashboard/events', icon: CalendarDays },
  { label: 'My Live', to: '/live', icon: Radio },
  { label: 'My Audit', to: '/dashboard/my-audit', icon: ScrollText },
]

const adminNav: NavItem[] = [
  { label: 'Live', to: '/dashboard/streams', icon: Radio },
  { label: 'Nodes', to: '/dashboard/nodes', icon: Network },
  { label: 'Users', to: '/dashboard/users', icon: Users },
  { label: 'Groups', to: '/dashboard/groups', icon: UsersRound },
  { label: 'Config', to: '/dashboard/config', icon: Settings },
  { label: 'Mail', to: '/dashboard/mail', icon: Mail },
  { label: 'Admin Audit', to: '/dashboard/audit', icon: ScrollText },
]

// '/dashboard' is a prefix of every dashboard route, so only highlight it on an
// exact match; every other item matches itself + its sub-paths.
function isActive(to: string): boolean {
  return to === '/dashboard'
    ? route.path === '/dashboard'
    : route.path === to || route.path.startsWith(to + '/')
}

function toggleTheme(): void {
  isDark.value = !isDark.value
}

// Close the mobile drawer whenever the route changes.
watch(
  () => route.path,
  () => {
    sidebarOpen.value = false
  },
)
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Mobile top bar (sidebar is off-canvas below lg) -->
    <div
      class="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card px-4 lg:hidden"
    >
      <Button variant="ghost" size="icon" @click="sidebarOpen = true">
        <Menu :size="18" />
      </Button>
      <AppLogo />
    </div>

    <!-- Mobile overlay -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/40 lg:hidden"
      @click="sidebarOpen = false"
    />

    <!-- Sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-transform duration-200 lg:translate-x-0"
      :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="flex h-14 items-center justify-between border-b px-4">
        <AppLogo />
        <Button
          variant="ghost"
          size="icon-sm"
          class="lg:hidden"
          @click="sidebarOpen = false"
        >
          <X :size="16" />
        </Button>
      </div>

      <nav class="flex-1 space-y-1 overflow-y-auto p-3">
        <NuxtLink
          v-for="item in generalNav"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
          :class="
            isActive(item.to)
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          "
        >
          <component :is="item.icon" :size="16" />
          {{ item.label }}
        </NuxtLink>

        <template v-if="isAdmin">
          <div
            class="px-3 pb-1 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground/60"
          >
            Administration
          </div>
          <NuxtLink
            v-for="item in adminNav"
            :key="item.to"
            :to="item.to"
            class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
            :class="
              isActive(item.to)
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            "
          >
            <component :is="item.icon" :size="16" />
            {{ item.label }}
          </NuxtLink>
        </template>
      </nav>

      <div class="space-y-2 border-t p-3">
        <Button variant="ghost" class="w-full justify-start" @click="toggleTheme">
          <Sun v-if="isDark" :size="16" />
          <Moon v-else :size="16" />
          {{ isDark ? 'Light mode' : 'Dark mode' }}
        </Button>

        <div v-if="user" class="space-y-2">
          <div
            class="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm"
          >
            <span class="truncate text-muted-foreground">{{ user.email }}</span>
            <Badge variant="secondary" class="uppercase">{{ user.role }}</Badge>
          </div>
          <Button
            variant="ghost"
            class="w-full justify-start text-muted-foreground"
            @click="logout"
          >
            <LogOut :size="16" />
            Sign out
          </Button>
        </div>
      </div>
    </aside>

    <!-- Content (offset for the fixed sidebar on lg+) -->
    <main class="lg:pl-64">
      <div class="mx-auto w-full max-w-4xl p-6">
        <slot />
      </div>
    </main>
  </div>
</template>
