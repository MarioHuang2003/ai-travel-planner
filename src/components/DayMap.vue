<script setup lang="ts">
/**
 * 单日地图组件。
 *
 * 职责：
 * 1. 加载/复用高德 SDK，渲染一张地图
 * 2. 把当天 activities 中已成功 geocode 的节点渲染为带编号 + 类型色的 marker
 * 3. 用 polyline 把节点按时间顺序连起来（直线，仅作整体路径示意）
 * 4. 自动 fitView 到所有节点
 * 5. 与父组件通过 props/emits 联动：父 hover/选中卡片 → 我跳动对应 marker；
 *                                       我点 marker → 通知父滚动到对应卡片
 *
 * 交互细节：
 * - 没配 Key：完全不渲染（父组件控制是否挂载）
 * - geocode 全部失败：显示「节点位置都无法确定」提示
 * - 部分失败：能显示几个就显示几个，列出未识别的节点名
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElIcon, ElMessage } from 'element-plus'
import { Loading, Warning } from '@element-plus/icons-vue'
import {
  useItineraryStore,
  type Activity,
  type ActivityType,
} from '../store/useItineraryStore'
import {
  getCachedGeocode,
  inferCityFromText,
} from '../api/amapService'
import {
  hasAMapKey,
  loadAMap,
  type AMapInstance,
  type AMapNamespace,
  type AMapOverlay,
} from '../utils/amapLoader'

interface Props {
  activities: Activity[]
  /** 当前天序号（0-based），用于父子联动的 key */
  dayIndex: number
  /** 父组件传入：当前 hover/选中的卡片索引 (-1 = 无) */
  highlightedIndex?: number
}

const props = withDefaults(defineProps<Props>(), {
  highlightedIndex: -1,
})

const emit = defineEmits<{
  (e: 'pickActivity', activityIndex: number): void
  /** marker 命中多个 activity 时通知父级（用于 toast 提示） */
  (e: 'pickCluster', primaryIndex: number, otherIndexes: number[]): void
}>()

const store = useItineraryStore()
const { itinerary, geocodeRevision, isGeocodingBatch, geocodingProgress } = storeToRefs(store)

/** 进度百分比（显示用），任务结束后回归 0 */
const progressPct = computed(() => {
  const { done, total } = geocodingProgress.value
  if (!isGeocodingBatch.value || total === 0) return 0
  return Math.round((done / total) * 100)
})

/** 当前正在识别的地点（最多展示 2 个，太多 tooltip 太长） */
const inFlightPreview = computed(() => {
  const list = geocodingProgress.value.inFlight
  if (!list.length) return ''
  if (list.length <= 2) return list.join('、')
  return `${list.slice(0, 2).join('、')} 等 ${list.length} 个`
})

const ACTIVITY_COLOR: Record<ActivityType, string> = {
  attraction: '#67c23a',
  food: '#e6a23c',
  transit: '#409eff',
  hotel: '#a78bfa',
}

const ACTIVITY_EMOJI: Record<ActivityType, string> = {
  attraction: '🏛️',
  food: '🍜',
  transit: '🚇',
  hotel: '🏨',
}

const containerRef = ref<HTMLDivElement | null>(null)
const mapState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const errorMessage = ref('')

let AMap: AMapNamespace | null = null
let mapInstance: AMapInstance | null = null
let markers: AMapOverlay[] = []
let polyline: AMapOverlay | null = null

const cityHint = computed(() =>
  inferCityFromText(itinerary.value.trip_title, itinerary.value.summary),
)

/**
 * 把当前天的 activities 与各自的 geocode 结果配对。
 * 依赖 geocodeRevision 让 reactive 能感知到 cache 内部的更新。
 */
const positioned = computed(() => {
  // 依赖 revision 触发重算
  void geocodeRevision.value
  return props.activities.map((act, idx) => {
    const actCityHint = inferCityFromText(act.address, act.location, cityHint.value)
    const cached = getCachedGeocode(act.location, actCityHint, act.address)
    return {
      activity: act,
      activityIndex: idx,
      coords: cached?.status === 'ok' ? cached.coords : undefined,
      status: cached?.status ?? 'pending',
      error: cached?.error,
    }
  })
})

const located = computed(() => positioned.value.filter((p) => p.coords))
const failed = computed(() => positioned.value.filter((p) => p.status === 'fail'))
const pending = computed(() => positioned.value.filter((p) => p.status === 'pending'))

/**
 * 把同坐标的多个 activity 合并成一个聚合点。
 * 精度 4 位小数 ≈ 11 米，足以判断"同地点"。
 */
interface Cluster {
  coords: { lng: number; lat: number }
  items: typeof positioned.value
}

const clusters = computed<Cluster[]>(() => {
  const map = new Map<string, Cluster>()
  for (const it of located.value) {
    const c = it.coords!
    const k = `${c.lng.toFixed(4)},${c.lat.toFixed(4)}`
    if (!map.has(k)) {
      map.set(k, { coords: { lng: c.lng, lat: c.lat }, items: [] })
    }
    map.get(k)!.items.push(it)
  }
  return [...map.values()]
})

/**
 * 把一组 activity index 渲染成简短文本：
 *   [1]       -> "1"
 *   [1,2,3]   -> "1-3"
 *   [1,3,5]   -> "1,3,5"
 *   [1,2,4,5] -> "1,2,4,5"
 */
function formatIndexes(indexes: number[]): string {
  if (indexes.length === 1) return String(indexes[0] + 1)
  const sorted = [...indexes].sort((a, b) => a - b)
  // 是否完全连续
  const consecutive = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1)
  if (consecutive) return `${sorted[0] + 1}-${sorted[sorted.length - 1] + 1}`
  return sorted.map((i) => i + 1).join(',')
}

// ==================== 地图初始化 ====================
async function initMap() {
  if (!containerRef.value) return
  if (!hasAMapKey()) return
  mapState.value = 'loading'
  const result = await loadAMap()
  if (!result.ok) {
    mapState.value = 'error'
    errorMessage.value = result.message
    return
  }
  AMap = result.AMap
  try {
    mapInstance = new AMap.Map(containerRef.value, {
      zoom: 12,
      viewMode: '2D',
      mapStyle: 'amap://styles/whitesmoke',
      resizeEnable: true,
    })
    mapState.value = 'ready'
    renderMarkers()
  } catch (err) {
    console.error('[DayMap] init failed', err)
    mapState.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : '地图初始化失败'
  }
}

function destroyMap() {
  cleanupOverlays()
  if (mapInstance) {
    try {
      mapInstance.destroy()
    } catch (err) {
      console.warn('[DayMap] destroy failed', err)
    }
    mapInstance = null
  }
}

function cleanupOverlays() {
  if (mapInstance) {
    if (markers.length) mapInstance.remove(markers)
    if (polyline) mapInstance.remove(polyline)
  }
  markers = []
  polyline = null
}

// ==================== Marker / Polyline ====================
function renderMarkers() {
  if (!AMap || !mapInstance) return
  cleanupOverlays()

  const groups = clusters.value
  if (!groups.length) return

  for (const group of groups) {
    const indexes = group.items.map((it) => it.activityIndex)
    const label = formatIndexes(indexes)
    // 主类型 = 该 cluster 中第一个 activity 的类型（按时间顺序，第一个最有代表性）
    const primary = group.items.reduce((min, cur) =>
      cur.activityIndex < min.activityIndex ? cur : min,
    )
    const isCluster = indexes.length > 1
    const marker = new AMap.Marker({
      position: new AMap.LngLat(group.coords.lng, group.coords.lat),
      content: buildMarkerHtml(label, primary.activity.type, isCluster),
      offset: new AMap.Pixel(-18, -42),
      title: isCluster
        ? group.items
            .sort((a, b) => a.activityIndex - b.activityIndex)
            .map((it) => `${it.activity.time} · ${it.activity.location}`)
            .join('\n')
        : `${primary.activity.time} · ${primary.activity.location}`,
      extData: {
        activityIndexes: indexes,
        primaryIndex: Math.min(...indexes),
      },
      zIndex: 100,
    })
    marker.on('click', () => {
      const sorted = [...indexes].sort((a, b) => a - b)
      const primaryIdx = sorted[0]
      if (sorted.length === 1) {
        emit('pickActivity', primaryIdx)
      } else {
        emit('pickCluster', primaryIdx, sorted.slice(1))
      }
    })
    markers.push(marker)
  }
  mapInstance.add(markers)

  // polyline：按时间顺序连接所有定位成功的节点（同点会合并 marker，但路径还是按 activity 序）
  const path = located.value
    .sort((a, b) => a.activityIndex - b.activityIndex)
    .map((it) => new AMap!.LngLat(it.coords!.lng, it.coords!.lat))
  if (path.length >= 2) {
    polyline = new AMap.Polyline({
      path,
      strokeColor: '#6366f1',
      strokeWeight: 3,
      strokeOpacity: 0.65,
      strokeStyle: 'dashed',
      lineJoin: 'round',
      zIndex: 50,
    })
    mapInstance.add(polyline)
  }

  mapInstance.setFitView(markers, false, [40, 40, 40, 40])
}

function buildMarkerHtml(label: string, type: ActivityType, isCluster: boolean): string {
  const color = ACTIVITY_COLOR[type]
  const emoji = ACTIVITY_EMOJI[type]
  // 聚合标记宽一点，文字号稍小，方便容纳"1-3"或"1,3,5"
  const isWide = label.length > 1
  const width = isWide ? 44 : 36
  const fontSize = isWide ? 12 : 14
  const offsetX = width / 2
  return `
    <div style="position:relative;width:${width}px;height:48px;cursor:pointer;">
      <div style="
        width:${width}px;height:36px;border-radius:18px;
        background:${color};color:#fff;
        display:flex;align-items:center;justify-content:center;
        font-size:${fontSize}px;font-weight:700;
        border:2px solid #fff;
        box-shadow:0 4px 10px rgba(0,0,0,0.25);
        font-variant-numeric: tabular-nums;
        letter-spacing:0.3px;
      ">${label}</div>
      <div style="
        position:absolute;top:-6px;right:-6px;
        width:20px;height:20px;border-radius:50%;
        background:#fff;border:1px solid ${color};
        font-size:11px;line-height:18px;text-align:center;
      ">${isCluster ? '★' : emoji}</div>
      <div style="
        position:absolute;bottom:-2px;left:${offsetX}px;transform:translateX(-50%);
        width:0;height:0;
        border-left:6px solid transparent;
        border-right:6px solid transparent;
        border-top:8px solid ${color};
      "></div>
    </div>
  `
}

// ==================== 联动：父 highlight → marker 跳动 ====================
let lastHighlightedMarker: AMapOverlay | null = null

function applyHighlight(idx: number) {
  if (lastHighlightedMarker?.setAnimation) {
    lastHighlightedMarker.setAnimation('AMAP_ANIMATION_NONE')
    lastHighlightedMarker = null
  }
  if (idx < 0) return
  // 找到包含该 activity 的 marker（聚合 marker 一个 marker 关联多个 index）
  const m = markers.find((mk) => {
    const ext = mk.getExtData?.() as { activityIndexes?: number[] } | undefined
    return ext?.activityIndexes?.includes(idx)
  })
  if (m?.setAnimation) {
    m.setAnimation('AMAP_ANIMATION_BOUNCE')
    lastHighlightedMarker = m
  }
}

// ==================== 生命周期 + 响应 ====================
onMounted(() => {
  void initMap()
})

onBeforeUnmount(() => {
  destroyMap()
})

// activities 或 geocode 完成时重渲
watch(
  [() => props.activities, geocodeRevision],
  () => {
    if (mapState.value === 'ready') renderMarkers()
  },
)

watch(
  () => props.highlightedIndex,
  (idx) => {
    if (mapState.value === 'ready') applyHighlight(idx)
  },
)

// ==================== 用户主动重试识别 ====================
/**
 * 重试由 store.retryFailedGeocodes 统一管理（带防重入 + 60s 兜底超时）。
 * 这里只负责"调用 + 弹消息"，不再各自维护 ref，避免多个组件状态打架。
 */
async function handleRetry() {
  if (isGeocodingBatch.value) return
  const { retried, succeeded, timedOut } = await store.retryFailedGeocodes()
  if (timedOut) {
    ElMessage.warning(
      '识别超过 40 秒未完成，可能是网络慢或高德 Key 限流。请稍后再试，或检查 .env.local 中的 VITE_AMAP_KEY。',
    )
    return
  }
  if (!retried) {
    ElMessage.info('当前已经全部识别成功')
  } else if (succeeded === retried) {
    ElMessage.success(`已识别全部 ${retried} 个未识别地点`)
  } else if (succeeded > 0) {
    ElMessage.success(`新识别 ${succeeded}/${retried} 个；剩下的可能确实是错误地名`)
  } else {
    ElMessage.warning(
      '高德仍然识别不到。建议点对应节点的「修改」按钮，让 AI 换个更知名的地标。',
    )
  }
}
</script>

<template>
  <div class="day-map" data-html2canvas-ignore="true">
    <!-- 地图容器：始终渲染，避免延迟挂载导致初始化失败 -->
    <div ref="containerRef" class="day-map__canvas" />

    <!-- 加载中遮罩 -->
    <div v-if="mapState === 'loading'" class="day-map__overlay">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在加载地图…</span>
    </div>

    <!-- 加载失败 -->
    <div v-else-if="mapState === 'error'" class="day-map__overlay day-map__overlay--error">
      <el-icon><Warning /></el-icon>
      <div>
        <strong>地图加载失败</strong>
        <p>{{ errorMessage }}</p>
      </div>
    </div>

    <!-- 状态条：显示已定位/失败/进行中 -->
    <div v-if="mapState === 'ready'" class="day-map__status" aria-live="polite">
      <span class="day-map__status-pill day-map__status-pill--ok">
        ✓ 已定位 {{ located.length }} 个
      </span>
      <!-- 批量识别中：带进度条的胶囊 -->
      <span
        v-if="isGeocodingBatch"
        class="day-map__status-pill day-map__progress"
        :title="
          inFlightPreview
            ? `正在识别：${inFlightPreview}`
            : '正在向高德发送请求…'
        "
      >
        <span class="day-map__progress-bar">
          <span
            class="day-map__progress-bar-fill"
            :style="{ width: `${progressPct}%` }"
          />
          <span class="day-map__progress-bar-shimmer" aria-hidden="true" />
        </span>
        <span class="day-map__progress-text">
          识别中 {{ geocodingProgress.done }} / {{ geocodingProgress.total }}
        </span>
      </span>

      <!-- 没在跑、但仍有 pending 的兜底提示 -->
      <span
        v-else-if="pending.length"
        class="day-map__status-pill day-map__status-pill--pending"
      >
        ⏳ 待识别 {{ pending.length }} 个
      </span>

      <!-- 重试按钮：仅在没在跑、且有失败/卡住的节点时出现 -->
      <button
        v-if="!isGeocodingBatch && (failed.length || pending.length)"
        type="button"
        class="day-map__status-pill day-map__status-pill--fail day-map__retry"
        :title="
          `未识别：${failed.map(f => f.activity.location).join('、') || '（解析卡住）'}\n点击重新识别（最多 40s）`
        "
        :aria-label="`重试识别 ${failed.length || pending.length} 个未定位地点`"
        @click="handleRetry"
      >
        <el-icon><Warning /></el-icon>
        <span>
          ⚠ 未识别 {{ failed.length || pending.length }} 个 · 点此重试
        </span>
      </button>
    </div>

    <!-- 节点全部失败时的兜底 -->
    <div v-if="mapState === 'ready' && !located.length && !pending.length" class="day-map__empty">
      <el-icon><Warning /></el-icon>
      <span>当天的节点位置都无法被高德识别，可能是地名过于模糊。</span>
    </div>
  </div>
</template>

<style scoped>
.day-map {
  position: relative;
  width: 100%;
  height: 320px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  background: #f5f7fb;
  margin-bottom: 16px;
}

.day-map__canvas {
  width: 100%;
  height: 100%;
}

.day-map__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 16px;
  text-align: center;
}
.day-map__overlay--error {
  background: rgba(254, 242, 242, 0.95);
  color: var(--el-color-danger);
}
.day-map__overlay--error strong {
  display: block;
  margin-bottom: 4px;
  font-size: 14px;
}
.day-map__overlay--error p {
  margin: 0;
  font-size: 12px;
  opacity: 0.85;
}
.day-map__overlay .is-loading {
  font-size: 22px;
  animation: planner-spin 1s linear infinite;
}

.day-map__status {
  position: absolute;
  top: 10px;
  left: 10px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  z-index: 10;
  pointer-events: none;
}
.day-map__status-pill {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(15, 23, 42, 0.08);
  pointer-events: auto;
}
.day-map__status-pill--ok {
  color: #2f9e44;
}
.day-map__status-pill--pending {
  color: #6b7280;
}
.day-map__status-pill--fail {
  color: #b45309;
  cursor: help;
}

/* 「未识别 X 个·点此重试」按钮：在 status pill 基础上加交互态 */
.day-map__retry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-color: rgba(180, 83, 9, 0.4);
  background: rgba(254, 243, 199, 0.95);
  color: #92400e;
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  transition: all 0.15s ease;
}

.day-map__retry:hover:not(:disabled),
.day-map__retry:focus-visible:not(:disabled) {
  background: #f59e0b;
  color: #fff;
  border-color: #f59e0b;
  outline: none;
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(245, 158, 11, 0.25);
}

.day-map__retry:disabled {
  opacity: 0.7;
  cursor: progress;
}

/* ==================== 批量识别进度胶囊 ==================== */
.day-map__progress {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  color: #6366f1;
  background: rgba(238, 242, 255, 0.95);
  border-color: rgba(99, 102, 241, 0.3);
  cursor: help;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  /* 微微脉动，强化"正在工作"的感知 */
  animation: planner-pulse 1.6s ease-in-out infinite;
}

@keyframes planner-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.0); }
  50%      { box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15); }
}

.day-map__progress-bar {
  position: relative;
  width: 60px;
  height: 4px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.15);
  overflow: hidden;
}

.day-map__progress-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, #818cf8, #6366f1);
  border-radius: 999px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 滑动光带：哪怕进度未变，用户也能看到"在跑" */
.day-map__progress-bar-shimmer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 30%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.7) 50%,
    transparent 100%
  );
  animation: planner-shimmer 1.4s linear infinite;
  pointer-events: none;
}

@keyframes planner-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(370%); }
}

.day-map__progress-text {
  font-size: 12px;
  white-space: nowrap;
}

.day-map__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 16px;
}
</style>
