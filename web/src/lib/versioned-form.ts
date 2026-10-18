import { useState, type SetStateAction } from 'react'

export const FORM_CONFLICT_MESSAGE = '配置已被其他操作更新，请重新加载后再保存。'

/** Keep the editing baseline and its version together, even during revalidation. */
export function useVersionedForm<T>(initial: T, version: number) {
  const [snapshot, setSnapshot] = useState({ value: initial, baseline: initial, version })
  const dirty = JSON.stringify(snapshot.value) !== JSON.stringify(snapshot.baseline)

  // Synchronize before rendering children. Dirty drafts retain their baseline.
  if (!dirty && version !== snapshot.version) {
    setSnapshot({ value: initial, baseline: initial, version })
  }

  const setValue = (update: SetStateAction<T>) => setSnapshot((previous) => ({
    ...previous,
    value: typeof update === 'function' ? (update as (value: T) => T)(previous.value) : update,
  }))
  const reset = (value: T, savedVersion: number) => {
    setSnapshot({ value, baseline: value, version: savedVersion })
  }

  return { value: snapshot.value, setValue, version: snapshot.version, conflict: dirty && version !== snapshot.version, reset }
}
