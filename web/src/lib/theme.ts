import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export const THEME_STORAGE_KEY = 'yunji-task.theme'
export const normalizeTheme = (value: unknown): ThemePreference => value === 'light' || value === 'dark' ? value : 'system'

function savedTheme(): ThemePreference {
  try { return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY)) } catch { return 'system' }
}

let preference = savedTheme()
const media = typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()
export const getTheme = () => preference
export const isDarkTheme = () => preference === 'dark' || (preference === 'system' && (media?.matches ?? false))

function apply() {
  if (typeof document === 'undefined') return
  const mode = isDarkTheme() ? 'dark' : 'light'
  document.documentElement.dataset.mode = mode
  document.documentElement.style.colorScheme = mode
}
function notify() {
  apply()
  listeners.forEach((listener) => listener())
}
function onStorage(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
  preference = savedTheme()
  notify()
}
function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    media?.addEventListener('change', notify)
    window.addEventListener('storage', onStorage)
    apply()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      media?.removeEventListener('change', notify)
      window.removeEventListener('storage', onStorage)
    }
  }
}
export function setTheme(value: ThemePreference) {
  preference = normalizeTheme(value)
  try { localStorage.setItem(THEME_STORAGE_KEY, preference) } catch { /* Keep selection usable without storage. */ }
  notify()
}
export const useTheme = () => useSyncExternalStore(subscribe, getTheme, () => 'system' as const)
export const useDarkMode = () => useSyncExternalStore(subscribe, isDarkTheme, () => false)

// Apply the saved choice before React's first render.
apply()
