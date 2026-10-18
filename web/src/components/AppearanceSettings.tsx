import { LayerCard, Radio, Text } from '@cloudflare/kumo'
import { tr, useLocale } from '../i18n'
import { normalizeTheme, setTheme, useTheme } from '../lib/theme'

export function AppearanceSettings() {
  useLocale()
  const theme = useTheme()
  return (
    <LayerCard>
      <LayerCard.Secondary><Text bold>{tr('外观')}</Text></LayerCard.Secondary>
      <LayerCard.Primary>
        <Radio.Group legend={tr('颜色模式')} value={theme} onValueChange={(value) => setTheme(normalizeTheme(value))}
          description={tr('立即生效，选择仅保存在当前浏览器。跟随系统会自动适应系统的浅色或深色模式。')}>
          <Radio.Item value="system" label={tr('跟随系统')} />
          <Radio.Item value="light" label={tr('浅色')} />
          <Radio.Item value="dark" label={tr('深色')} />
        </Radio.Group>
      </LayerCard.Primary>
    </LayerCard>
  )
}
