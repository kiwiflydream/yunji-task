// Tree-shaken ECharts core passed to Kumo's Chart. Only the modules the stats
// charts use are registered.
import { BarChart, LineChart } from 'echarts/charts'
import { AriaComponent, AxisPointerComponent, GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([BarChart, LineChart, AriaComponent, AxisPointerComponent, GridComponent, TooltipComponent, CanvasRenderer])

export { echarts }
