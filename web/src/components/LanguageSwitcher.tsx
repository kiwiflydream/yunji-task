import { changeLanguage, useLocale } from '../i18n'

export function LanguageSwitcher() {
  const locale = useLocale()
  return (
    <select
      aria-label="语言 / Language"
      value={locale}
      onChange={(event) => changeLanguage(event.target.value as 'zh-CN' | 'en')}
      className="min-h-9 rounded-lg border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-brand max-md:min-h-11"
    >
      <option value="zh-CN">简体中文</option>
      <option value="en">English</option>
    </select>
  )
}
