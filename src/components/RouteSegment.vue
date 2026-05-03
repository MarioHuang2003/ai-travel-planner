<script setup lang="ts">
/**
 * 「过渡段」组件：插入在两个相邻 activity 之间，
 * 显示从 A 到 B 在 5 种交通方式下的距离 + 用时 + 费用估算。
 *
 * 交互：
 * - 用户切 tab 即记录到 store.chosenModes（持久化），用于汇总总交通费
 * - 同地点（直线 < 50m）→ 显示「📍 原地」，不查路径不计费
 * - 步行/骑行明显不可达 → 标灰禁用
 * - 其他方式 lazy on click，避免无意义配额消耗
 */
import { computed, h, ref, watch, type FunctionalComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { ElIcon, ElPopover, ElTooltip } from 'element-plus'
import { Loading, Warning, ArrowDown } from '@element-plus/icons-vue'
import {
  useItineraryStore,
  type Activity,
} from '../store/useItineraryStore'
import {
  estimateFare,
  formatDistance,
  formatDuration,
  getCachedGeocode,
  getCachedRoute,
  inferCityFromText,
  planRoute,
  type RouteResult,
} from '../api/amapService'
import {
  hasAMapKey,
  isModeReasonable,
  roughDistanceKm,
  TRANSIT_MODE_META,
  type TransitMode,
} from '../utils/amapLoader'

interface Props {
  from: Activity
  to: Activity
  /** 当前在第几天，第几个相邻段（用于持久化用户选择） */
  dayIndex: number
  fromIndex: number
}

const props = defineProps<Props>()

const store = useItineraryStore()
const { itinerary, geocodeRevision, routeRevision, isGeocodingBatch } = storeToRefs(store)

const ALL_MODES: TransitMode[] = ['walking', 'riding', 'transit', 'driving', 'taxi']

/**
 * 5 种交通方式的 mono SVG 图标（替代 emoji）。
 * 风格：1.5px stroke，16x16 viewBox，跟新调色板的极简调性一致。
 * 用 h() 写成函数式组件，避免对每个 SVG 单独 import 文件。
 */
function svg(...children: unknown[]): FunctionalComponent {
  const Comp: FunctionalComponent = () =>
    h(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      },
      children as never[],
    )
  return Comp
}

const MODE_ICON: Record<TransitMode, FunctionalComponent> = {
  // 行走的人：圆头 + 折线身体腿
  walking: svg(
    h('circle', { cx: 9, cy: 3.2, r: 1.3 }),
    h('path', { d: 'M9 5.2 7 9.5l2.2 1.3L11.2 14.5' }),
    h('path', { d: 'M7 9.5 4.6 8.6' }),
    h('path', { d: 'M11.2 10.8l-1.4 3.7' }),
  ),
  // 自行车：两轮 + 把手 + 链条
  riding: svg(
    h('circle', { cx: 4, cy: 11, r: 2.4 }),
    h('circle', { cx: 12, cy: 11, r: 2.4 }),
    h('path', { d: 'M4 11l3-5h3l2 5' }),
    h('path', { d: 'M7 6h2.5' }),
  ),
  // 地铁/公交：方形车厢 + 两个轮子 + 顶部小灯
  transit: svg(
    h('rect', { x: 3.5, y: 2.5, width: 9, height: 9, rx: 1.6 }),
    h('path', { d: 'M3.5 8h9' }),
    h('circle', { cx: 6, cy: 9.8, r: 0.5, fill: 'currentColor' }),
    h('circle', { cx: 10, cy: 9.8, r: 0.5, fill: 'currentColor' }),
    h('path', { d: 'M5.5 12.5l-1 1.5' }),
    h('path', { d: 'M10.5 12.5l1 1.5' }),
  ),
  // 汽车：流线车顶 + 车身 + 两轮
  driving: svg(
    h('path', { d: 'M2.5 10h11l-1.2-3.5a2 2 0 0 0-1.9-1.4H5.6a2 2 0 0 0-1.9 1.4L2.5 10Z' }),
    h('path', { d: 'M2.5 10v2h2v-2' }),
    h('path', { d: 'M11.5 10v2h2v-2' }),
    h('circle', { cx: 5, cy: 11, r: 1.2 }),
    h('circle', { cx: 11, cy: 11, r: 1.2 }),
  ),
  // 出租车：和 driving 类似，多一个顶灯
  taxi: svg(
    h('rect', { x: 6, y: 1.6, width: 4, height: 1.6, rx: 0.4 }),
    h('path', { d: 'M2.5 10h11l-1.2-3.5a2 2 0 0 0-1.9-1.4H5.6a2 2 0 0 0-1.9 1.4L2.5 10Z' }),
    h('path', { d: 'M2.5 10v2h2v-2' }),
    h('path', { d: 'M11.5 10v2h2v-2' }),
    h('circle', { cx: 5, cy: 11, r: 1.2 }),
    h('circle', { cx: 11, cy: 11, r: 1.2 }),
  ),
}

const cityHint = computed(() =>
  inferCityFromText(itinerary.value.trip_title, itinerary.value.summary),
)

/** 取出 from / to 的坐标（依赖 geocodeRevision 触发重算） */
const coords = computed(() => {
  void geocodeRevision.value
  const cityHintFrom = inferCityFromText(props.from.address, props.from.location, cityHint.value)
  const cityHintTo = inferCityFromText(props.to.address, props.to.location, cityHint.value)
  const f = getCachedGeocode(props.from.location, cityHintFrom, props.from.address)
  const t = getCachedGeocode(props.to.location, cityHintTo, props.to.address)
  return {
    from: f?.status === 'ok' ? f.coords : undefined,
    to: t?.status === 'ok' ? t.coords : undefined,
  }
})

/** 大圆距离粗算（km）— 用于判断步行/骑行是否合理 */
const roughKm = computed(() => {
  const { from, to } = coords.value
  if (!from || !to) return undefined
  return roughDistanceKm(from, to)
})

/** 同地点：直线距离 < 50m 就视为原地，不查路径不计费 */
const isSameSpot = computed(() => roughKm.value !== undefined && roughKm.value < 0.05)

/**
 * 当前选中的交通方式。
 * - 用户选过 → 用用户选的（持久化在 store）
 * - 没选过 → 按距离智能推荐：< 1.2km 步行 / < 8km 公交 / >8km 驾车
 *   避免出现"步行 50km" 这种 disabled 选择，让首次显示永远是合理的。
 */
const activeMode = computed<TransitMode>(() =>
  store.getChosenMode(props.dayIndex, props.fromIndex, store.recommendModeByKm(roughKm.value)),
)

/** 该方式当前结果（依赖 routeRevision 让 cache 更新可见） */
const activeResult = computed<RouteResult | undefined>(() => {
  void routeRevision.value
  return getCachedRoute(coords.value.from, coords.value.to, activeMode.value)
})

/** 该方式的费用估算（用真实 distance，没有就用 rough） */
const activeFare = computed(() => {
  const { from, to } = coords.value
  if (!from || !to) return undefined
  const fareCity = to.city ?? from.city ?? cityHint.value
  // 优先用 API 真实距离，没有就用粗算的
  const meters =
    activeResult.value?.status === 'ok' && activeResult.value.distance !== undefined
      ? activeResult.value.distance
      : roughKm.value !== undefined
        ? roughKm.value * 1000
        : undefined
  if (meters === undefined) return undefined
  return estimateFare(activeMode.value, meters, fareCity)
})

/** 加载中的 mode 集合（多 mode 可并发加载） */
const loadingModes = ref<Set<TransitMode>>(new Set())

async function ensureMode(mode: TransitMode) {
  if (!hasAMapKey()) return
  const { from, to } = coords.value
  if (!from || !to) return
  if (isSameSpot.value) return
  // 不合理的 mode（步行 50km）不发请求，节省高德配额
  if (roughKm.value !== undefined && !isModeReasonable(mode, roughKm.value)) return
  if (loadingModes.value.has(mode)) return
  // 命中"非 fail"缓存就不再请求；fail 现在不缓存所以会自动重试
  const cached = getCachedRoute(from, to, mode)
  if (cached && cached.status !== 'pending' && cached.status !== 'fail') return

  loadingModes.value.add(mode)
  try {
    await planRoute(from, to, mode, cityHint.value)
    store.bumpRouteRevision()
  } finally {
    loadingModes.value.delete(mode)
  }
}

function pickMode(mode: TransitMode) {
  store.setChosenMode(props.dayIndex, props.fromIndex, mode)
  void ensureMode(mode)
}

/**
 * watch 必须依赖 coords —— 这是上一版的核心 bug：
 * 监听 location 字符串时，geocode 完成后 coords 才有值，但字符串没变，
 * 永远不再触发 → walking 显示 "点击查看"，必须用户手动切才出数据。
 *
 * 加上 activeMode：用户切了 mode 之后也走这个 watch（pickMode 已经调过 ensureMode，
 * 这里是双保险，避免 setChosenMode 来源不一致时漏加载）。
 */
watch(
  [
    () => coords.value.from?.lng,
    () => coords.value.from?.lat,
    () => coords.value.to?.lng,
    () => coords.value.to?.lat,
    activeMode,
  ],
  () => {
    void ensureMode(activeMode.value)
  },
  { immediate: true },
)

/** 控制交通方式选择 popover 的开关 */
const modePickerOpen = ref(false)

/**
 * 取某 mode 的"距离 · 用时"小字，没结果就返回空。
 * 用在 popover 列表上，让用户切换前能看到各方式的耗时。
 */
function summaryOf(mode: TransitMode): string {
  void routeRevision.value
  const r = getCachedRoute(coords.value.from, coords.value.to, mode)
  if (!r || r.status !== 'ok') return ''
  return `${formatDistance(r.distance)} · ${formatDuration(r.duration)}`
}

/** 切换 mode 后顺便关 popover；mode 不变时也关 */
function pickModeFromPopover(mode: TransitMode) {
  pickMode(mode)
  modePickerOpen.value = false
}

/** 没坐标时的显示态 */
const missingCoords = computed(() => !coords.value.from || !coords.value.to)

/** 缺位置的那个节点：用于错误提示 + 引导用户操作 */
const missingActivity = computed(() => {
  if (!coords.value.from) return props.from
  if (!coords.value.to) return props.to
  return null
})
</script>

<template>
  <div class="route-seg" data-html2canvas-ignore="true">
    <!-- 没配 Key：完全不渲染（父级已判断，这里再防一手） -->
    <template v-if="!hasAMapKey()"></template>

    <!-- 同地点：极简显示 -->
    <div v-else-if="isSameSpot" class="route-seg__line route-seg__line--muted">
      <span class="route-seg__dash" />
      <span>同地点 · 原地停留</span>
      <span class="route-seg__dash" />
    </div>

    <!-- 坐标缺失：极简降级；重试按钮统一在 DayMap 顶部，避免按钮泛滥 -->
    <div v-else-if="missingCoords" class="route-seg__line route-seg__line--muted">
      <span class="route-seg__dash" />
      <template v-if="isGeocodingBatch">
        <span class="route-seg__locating">
          <span class="route-seg__locating-dot" aria-hidden="true" />
          <span class="route-seg__locating-dot" aria-hidden="true" />
          <span class="route-seg__locating-dot" aria-hidden="true" />
          <span class="route-seg__locating-text">
            正在识别 {{ missingActivity?.location }} 的位置…
          </span>
        </span>
      </template>
      <template v-else>
        <el-tooltip
          :content="
            (missingActivity?.address
              ? `地址：${missingActivity.address}\n`
              : '') + '可在地图顶部点「未识别 N 个 · 重试」一次性重试'
          "
          placement="top"
        >
          <span class="route-seg__missing">
            <el-icon><Warning /></el-icon>
            无法计算路线：{{ missingActivity?.location }} 位置未识别
          </span>
        </el-tooltip>
      </template>
      <span class="route-seg__dash" />
    </div>

    <div v-else class="route-seg__main">
      <!-- 左侧虚线指示这是过渡段 -->
      <span class="route-seg__dash" />

      <!--
        紧凑型「单 chip + popover」：默认只显示当前选中的交通方式 + 距离/时间/费用。
        点击 chip 弹出 popover，里面以列表形式展示所有 5 种方式（带各自数据），
        切换后 popover 自动关闭。窄屏 / 探索面板打开时也不会撑爆 timeline 区。
      -->
      <el-popover
        v-model:visible="modePickerOpen"
        placement="top"
        :width="240"
        trigger="click"
        :show-arrow="true"
        popper-class="route-seg__popper"
      >
        <template #reference>
          <button
            type="button"
            class="route-seg__chip"
            :title="`当前：${TRANSIT_MODE_META[activeMode].label}（点击切换）`"
            :style="{
              '--seg-color': TRANSIT_MODE_META[activeMode].color,
              '--seg-soft': TRANSIT_MODE_META[activeMode].softColor,
            }"
          >
            <span class="route-seg__chip-icon" aria-hidden="true">
              <component :is="MODE_ICON[activeMode]" />
            </span>
            <span class="route-seg__chip-mode">
              {{ TRANSIT_MODE_META[activeMode].label }}
            </span>

            <!-- 当前结果：根据状态显示加载 / 数据 / 错误 / 待查 -->
            <template v-if="loadingModes.has(activeMode) && !activeResult">
              <span class="route-seg__chip-data route-seg__chip-data--idle">
                <el-icon class="is-loading"><Loading /></el-icon>
                查询中
              </span>
            </template>
            <template v-else-if="activeResult?.status === 'ok'">
              <el-tooltip
                v-if="activeFare"
                :content="activeFare.note"
                placement="top"
              >
                <span class="route-seg__chip-data">
                  {{ formatDistance(activeResult.distance) }}
                  · {{ formatDuration(activeResult.duration) }}
                  <span class="route-seg__fare">
                    · {{ activeFare.fare === 0 ? '免费' : `约 ¥${activeFare.fare}` }}
                  </span>
                </span>
              </el-tooltip>
              <span v-else class="route-seg__chip-data">
                {{ formatDistance(activeResult.distance) }}
                · {{ formatDuration(activeResult.duration) }}
              </span>
            </template>
            <template v-else-if="activeResult?.status === 'unreachable'">
              <span class="route-seg__chip-data route-seg__chip-data--bad">不可达</span>
            </template>
            <template v-else-if="activeResult?.status === 'fail'">
              <span class="route-seg__chip-data route-seg__chip-data--bad">查询失败</span>
            </template>
            <template v-else>
              <span class="route-seg__chip-data route-seg__chip-data--idle">
                待查询
              </span>
            </template>

            <el-icon class="route-seg__chip-caret" aria-hidden="true">
              <ArrowDown />
            </el-icon>
          </button>
        </template>

        <!-- popover 内容：5 种方式列表，点击直接切换 -->
        <div class="route-seg__menu" role="listbox" aria-label="选择交通方式">
          <div class="route-seg__menu-head">切换交通方式</div>
          <button
            v-for="mode in ALL_MODES"
            :key="mode"
            type="button"
            role="option"
            :aria-selected="activeMode === mode"
            class="route-seg__menu-item"
            :class="{
              'is-active': activeMode === mode,
              'is-disabled': roughKm !== undefined && !isModeReasonable(mode, roughKm),
            }"
            :title="
              roughKm !== undefined && !isModeReasonable(mode, roughKm)
                ? `直线距离约 ${roughKm.toFixed(1)}km，${TRANSIT_MODE_META[mode].label}不太适合`
                : `切到${TRANSIT_MODE_META[mode].label}`
            "
            :disabled="roughKm !== undefined && !isModeReasonable(mode, roughKm)"
            :style="{
              '--seg-color': TRANSIT_MODE_META[mode].color,
              '--seg-soft': TRANSIT_MODE_META[mode].softColor,
            }"
            @click="pickModeFromPopover(mode)"
          >
            <span class="route-seg__menu-icon" aria-hidden="true">
              <component :is="MODE_ICON[mode]" />
            </span>
            <span class="route-seg__menu-label">
              {{ TRANSIT_MODE_META[mode].label }}
            </span>
            <span class="route-seg__menu-data">
              <template v-if="roughKm !== undefined && !isModeReasonable(mode, roughKm)">
                不适合
              </template>
              <template v-else-if="summaryOf(mode)">
                {{ summaryOf(mode) }}
              </template>
              <template v-else-if="loadingModes.has(mode)">查询中</template>
              <template v-else>—</template>
            </span>
          </button>
        </div>
      </el-popover>

      <span class="route-seg__dash" />
    </div>
  </div>
</template>

<style>
/* ============================================================
 * 非 scoped：popover 内容 teleport 到 body 上，scoped 选不到，
 * 这块独立维护"切换交通方式"列表样式
 * ============================================================ */

.route-seg__popper.el-popover {
  border-radius: 14px;
  border-color: var(--line-soft);
  box-shadow: var(--shadow-popover);
  padding: 10px;
}

.route-seg__menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.route-seg__menu-head {
  padding: 4px 10px 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-secondary);
  text-transform: uppercase;
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: 4px;
}

.route-seg__menu-item {
  display: grid;
  grid-template-columns: 26px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-primary);
  transition: background 0.15s ease;
  text-align: left;
}

.route-seg__menu-item:hover:not(.is-disabled):not(.is-active) {
  background: var(--surface-soft);
}

.route-seg__menu-item.is-active {
  background: var(--seg-soft);
  color: var(--seg-color);
}

.route-seg__menu-item.is-active .route-seg__menu-data {
  color: var(--seg-color);
  font-weight: 600;
}

.route-seg__menu-item.is-disabled,
.route-seg__menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.route-seg__menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--seg-soft);
  color: var(--seg-color);
}

.route-seg__menu-label {
  font-weight: 500;
}

.route-seg__menu-data {
  font-size: 11.5px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>

<style scoped>
.route-seg {
  margin: -4px 0 0 32px;
  padding: 4px 12px 8px;
}

.route-seg__main,
.route-seg__line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.route-seg__dash {
  flex: 1;
  height: 1px;
  border-top: 1px dashed var(--line, rgba(31, 28, 25, 0.18));
}

.route-seg__line--muted {
  color: var(--el-text-color-secondary);
  font-style: italic;
}

.route-seg__missing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #b45309;
  cursor: help;
  font-style: normal;
  font-weight: 500;
}

/* 「正在识别…」流动小点动效，比单纯 spinner 更生动 */
.route-seg__locating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent, #1f1c19);
  font-style: normal;
  font-weight: 500;
}

.route-seg__locating-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: route-seg-bounce 1.2s ease-in-out infinite;
}
.route-seg__locating-dot:nth-child(2) {
  animation-delay: 0.15s;
}
.route-seg__locating-dot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes route-seg-bounce {
  0%, 80%, 100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

.route-seg__locating-text {
  margin-left: 4px;
}

/* ============================================================
 * 紧凑型 chip：默认状态 — 当前 mode 的 icon + 名称 + 数据 + ▾
 * 整体可点击，触发上方的 popover 切换 mode。
 * ============================================================ */

.route-seg__chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 8px;
  border: 1px solid var(--seg-soft, var(--line-soft));
  background: var(--seg-soft, var(--surface-soft));
  border-radius: var(--radius-pill, 999px);
  font-family: inherit;
  font-size: 12px;
  color: var(--seg-color, var(--text-primary));
  cursor: pointer;
  flex-shrink: 0;
  transition: filter 0.15s ease, transform 0.15s ease,
    box-shadow 0.18s ease;
  font-variant-numeric: tabular-nums;
  max-width: 100%;
}

.route-seg__chip:hover {
  filter: brightness(0.97);
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(31, 28, 25, 0.08);
}

.route-seg__chip:focus-visible {
  outline: 2px solid var(--seg-color);
  outline-offset: 2px;
}

.route-seg__chip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--surface, #fff);
  color: var(--seg-color, var(--text-primary));
  flex-shrink: 0;
}

.route-seg__chip-mode {
  font-weight: 600;
  letter-spacing: 0.01em;
  flex-shrink: 0;
}

.route-seg__chip-data {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.route-seg__chip-data--idle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  font-weight: 500;
}

.route-seg__chip-data--bad {
  color: var(--accent-coral);
  font-weight: 600;
}

.route-seg__fare {
  opacity: 0.78;
  margin-left: 2px;
  font-weight: 500;
}

.route-seg__chip-caret {
  font-size: 11px;
  color: currentColor;
  opacity: 0.6;
  flex-shrink: 0;
}

.is-loading {
  animation: planner-spin 1s linear infinite;
}

@media (max-width: 768px) {
  .route-seg {
    margin-left: 8px;
  }
  /* 移动端隐藏中文标签，节省宽度 */
  .route-seg__chip-mode {
    display: none;
  }
}
</style>
