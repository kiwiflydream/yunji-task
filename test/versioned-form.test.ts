import { createElement, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useVersionedForm } from '../web/src/lib/versioned-form'

type Value = { url: string }
type Form = ReturnType<typeof useVersionedForm<Value>>
type Stage = { initial: Value; version: number; act?: (form: Form) => void }

/** Render the hook while independently advancing parent props and local saves. */
function scenario(stages: Stage[]) {
  let result: Pick<Form, 'value' | 'version' | 'conflict'> | undefined
  function Probe() {
    const [step, setStep] = useState(0)
    const stage = stages[step]
    const form = useVersionedForm(stage.initial, stage.version)
    result = { value: form.value, version: form.version, conflict: form.conflict }
    if (step < stages.length - 1) {
      stage.act?.(form)
      setStep(step + 1)
    }
    return createElement('output', null, JSON.stringify(result))
  }
  renderToString(createElement(Probe))
  return result!
}

const old = { url: 'https://example.com/old' }
const saved = { url: 'https://example.com/saved' }
const draft = { url: 'https://example.com/draft' }
const remote = { url: 'https://example.com/remote' }

describe('versioned form save acknowledgement', () => {
  it('keeps the acknowledged value and version before parent cache notifications arrive', () => {
    expect(scenario([
      { initial: old, version: 2, act: (form) => form.reset(saved, 3) },
      { initial: old, version: 2 },
    ])).toEqual({ value: saved, version: 3, conflict: false })
  })

  it('does not report a conflict when editing ahead of stale parent props', () => {
    expect(scenario([
      { initial: old, version: 2, act: (form) => form.reset(saved, 3) },
      { initial: old, version: 2, act: (form) => form.setValue(draft) },
      { initial: old, version: 2 },
    ])).toEqual({ value: draft, version: 3, conflict: false })
  })

  it('adopts a newer remote version when the form is pristine', () => {
    expect(scenario([
      { initial: saved, version: 3 },
      { initial: remote, version: 4 },
    ])).toEqual({ value: remote, version: 4, conflict: false })
  })

  it('preserves a dirty draft and its baseline when a newer remote version arrives', () => {
    expect(scenario([
      { initial: saved, version: 3, act: (form) => form.setValue(draft) },
      { initial: remote, version: 4 },
    ])).toEqual({ value: draft, version: 3, conflict: true })
  })
})
