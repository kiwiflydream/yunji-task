import { useSyncExternalStore } from 'react'
import { getLocale, LANGUAGE_STORAGE_KEY, resolveLocale, setLocale, subscribeLocale, tr, type Locale } from './locale'

export { tr } from './locale'

function savedLocale() {
  try { return localStorage.getItem(LANGUAGE_STORAGE_KEY) } catch { return null }
}

function updateDocument() {
  document.documentElement.lang = getLocale()
  document.title = tr('云吉 Task')
}

setLocale(resolveLocale(savedLocale(), navigator.languages))
updateDocument()
subscribeLocale(updateDocument)
window.addEventListener('storage', (event) => {
  if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) {
    setLocale(resolveLocale(savedLocale(), navigator.languages))
  }
})

export function changeLanguage(value: Locale) {
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, value) } catch { /* Keep switching available when storage is blocked. */ }
  setLocale(value)
}

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}
