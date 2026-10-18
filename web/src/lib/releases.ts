export const PROJECT_URL = 'https://github.com/kiwiflydream/yunji-task'
export const RELEASES_URL = `${PROJECT_URL}/releases`
export const LATEST_RELEASE_API = 'https://api.github.com/repos/kiwiflydream/yunji-task/releases/latest'

function releaseVersion(value: string): bigint[] {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
  if (!match) throw new Error('无法识别发布版本号，请查看变更记录。')
  return match.slice(1, 4).map(BigInt)
}

export function isNewerRelease(latest: string, current: string): boolean {
  const a = releaseVersion(latest)
  const b = releaseVersion(current)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

export async function fetchLatestRelease(): Promise<{ tag: string; url: string } | null> {
  try {
    const options = {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit' as const,
      referrerPolicy: 'no-referrer' as const,
      signal: AbortSignal.timeout(8_000),
    }
    const response = await fetch(LATEST_RELEASE_API, options)
    if (response.status === 404) return null
    if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求受限，请稍后重试。')
    if (!response.ok) throw new Error('检查更新失败，请稍后重试或查看变更记录。')
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || !('tag_name' in data) || typeof data.tag_name !== 'string'
      || !('draft' in data) || data.draft !== false || !('prerelease' in data) || data.prerelease !== false) {
      throw new Error('无法识别发布版本号，请查看变更记录。')
    }
    releaseVersion(data.tag_name)
    return { tag: data.tag_name, url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}` }
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new Error('检查更新超时，请稍后重试。')
    }
    if (error instanceof TypeError) throw new Error('无法连接 GitHub，请检查网络后重试。')
    if (error instanceof SyntaxError) throw new Error('无法识别发布版本号，请查看变更记录。')
    throw error
  }
}
