/** Bounds the caller's wait; cancelling an RPC cannot undo remote side effects. */
export async function withDeadline<T>(operation: PromiseLike<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`operation timeout after ${ms}ms`)), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try { (operation as PromiseLike<T> & { [Symbol.dispose]?: () => void })[Symbol.dispose]?.() } catch { /* preserve outcome */ }
  }
}
