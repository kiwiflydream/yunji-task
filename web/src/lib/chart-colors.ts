import { useSyncExternalStore } from 'react'

// All pairs validated with the dataviz palette checker against the Kumo base
// surface (light #ffffff, dark oklch(17% 0 0) ≈ #0f0f0f).
//
// Status (success / failed) starts from Kumo's semantic chart colors; dark
// mode uses its own steps to stay inside the lightness band. Red/green only
// reaches ΔE ≈ 6.3 under deutan/protan simulation, which is legal only with
// secondary encoding: stacked segments keep a 2px surface gap, a fixed order
// (success at the bottom), a legend and a table view.
const STATUS = {
  light: { success: '#00A63E', failed: '#FC574A' },
  dark: { success: '#009438', failed: '#F5533F' },
} as const

// Neutral series slots for measures like P50/P95 or avg/max.
const SERIES = {
  light: ['#2a78d6', '#eb6834'],
  dark: ['#3987e5', '#d95926'],
} as const

const SURFACE = { light: '#ffffff', dark: '#0f0f0f' } as const

const mode = (dark: boolean) => (dark ? 'dark' : 'light')
export const statusColors = (dark: boolean) => STATUS[mode(dark)]
export const seriesColors = (dark: boolean) => SERIES[mode(dark)]
/** Chart surface; used as the stroke that separates adjacent fills. */
export const surfaceColor = (dark: boolean) => SURFACE[mode(dark)]

const media = () => window.matchMedia('(prefers-color-scheme: dark)')

/** Tracks the system color scheme, same source as the `data-mode` attribute. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = media()
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => media().matches,
  )
}
