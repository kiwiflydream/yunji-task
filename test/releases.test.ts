import { afterEach, expect, it, vi } from 'vitest'
import { fetchLatestRelease, isNewerRelease, LATEST_RELEASE_API, RELEASES_URL } from '../web/src/lib/releases'

afterEach(() => vi.restoreAllMocks())

it.each([
  ['v0.1.1', '0.1.0', true], ['v0.10.0', '0.9.0', true],
  ['v1.0.0', '0.99.99', true], ['v0.1.0', '0.1.0', false],
  ['0.0.9', '0.1.0', false], ['v0.1.0+build.2', '0.1.0', false],
])('compares %s against %s numerically', (latest, current, expected) => {
  expect(isNewerRelease(latest, current)).toBe(expected)
})

it.each(['garbage', 'v01.0.0', 'v0.2.0-beta', '1.0'])('rejects unsupported release tags: %s', (tag) => {
  expect(() => isNewerRelease(tag, '0.1.0')).toThrow('无法识别')
})

it('checks the fixed public API without credentials and constructs a trusted release URL', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tag_name: 'v0.2.0', draft: false, prerelease: false, html_url: 'https://evil.example' }))
  expect(await fetchLatestRelease()).toEqual({ tag: 'v0.2.0', url: `${RELEASES_URL}/tag/v0.2.0` })
  expect(fetcher).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }))
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('handles a project with no release', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
  expect(await fetchLatestRelease()).toBeNull()
})

it.each([403, 429, 500])('reports HTTP %s without retrying', async (status) => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))
  await expect(fetchLatestRelease()).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('reports timeouts', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timeout', 'TimeoutError'))
  await expect(fetchLatestRelease()).rejects.toThrow('超时')
})

it.each([{ tag_name: 'v0.2.0', draft: true, prerelease: false }, { tag_name: 'v0.2.0', draft: false, prerelease: true }, {}])('rejects invalid release payloads', async (data) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(data))
  await expect(fetchLatestRelease()).rejects.toThrow('无法识别')
})
