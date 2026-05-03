<script setup lang="ts">
/**
 * POI 缩略地图：在 ExplorePanel 每张 POI 卡的顶部内嵌一张小地图。
 *
 * 性能权衡：
 * - 每个高德 Map 实例都不便宜（Canvas + DOM + Tile 请求），15 张卡同时挂载会卡
 * - 用 IntersectionObserver 懒实例化：卡片真正进入视口才创建 map
 * - 一旦实例化保持存活：滚动来回不重复销毁/重建（高德 Map 销毁有内部异步清理，
 *   反复创建容易触发警告）
 * - 父组件 v-for 切换 / 卡片 unmount 时通过 onBeforeUnmount 清理
 *
 * 没坐标的情况（AI 推荐有时缺）：直接返回降级占位，让用户依然能用"看地图"按钮
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  hasAMapKey,
  loadAMap,
  type AMapInstance,
  type AMapNamespace,
  type AMapOverlay,
} from '../utils/amapLoader'

interface Props {
  coords?: { lng: number; lat: number }
  /** POI 名字，用作 marker label */
  name: string
  /** 主题色：marker 圆点的填充颜色，默认蓝 */
  color?: string
}

const props = withDefaults(defineProps<Props>(), {
  color: '#409eff',
})

const containerRef = ref<HTMLDivElement | null>(null)
const mapState = ref<'idle' | 'loading' | 'ready' | 'error' | 'no-key' | 'no-coord'>('idle')

let mapInstance: AMapInstance | null = null
let marker: AMapOverlay | null = null
let observer: IntersectionObserver | null = null

/**
 * 简化版的"圆点 + 名字"标签 marker。直接拼 HTML 让样式跟卡片协调，
 * 不引依赖 AMap.LabelMarker（部分 SDK 版本要单独 plugin）。
 */
function buildMarkerContent(name: string, color: string): string {
  const safe = name.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `
    <div class="poi-mini-marker">
      <span class="poi-mini-marker__dot" style="background:${color};box-shadow:0 0 0 3px ${color}33"></span>
      <span class="poi-mini-marker__label">${safe}</span>
    </div>
  `
}

async function initMap() {
  if (mapInstance) return
  if (!containerRef.value) return
  if (!props.coords) {
    mapState.value = 'no-coord'
    return
  }
  if (!hasAMapKey()) {
    mapState.value = 'no-key'
    return
  }
  mapState.value = 'loading'
  const result = await loadAMap()
  if (!result.ok) {
    mapState.value = 'error'
    return
  }
  if (!containerRef.value) return
  try {
    const AMap: AMapNamespace = result.AMap
    mapInstance = new AMap.Map(containerRef.value, {
      zoom: 14,
      // 缩略图禁用滚轮/拖动，避免用户滚动列表时误操作小地图
      zoomEnable: false,
      dragEnable: false,
      doubleClickZoom: false,
      keyboardEnable: false,
      scrollWheel: false,
      viewMode: '2D',
      mapStyle: 'amap://styles/whitesmoke',
      center: [props.coords.lng, props.coords.lat],
      resizeEnable: false,
    })
    marker = new AMap.Marker({
      position: [props.coords.lng, props.coords.lat],
      anchor: 'bottom-center',
      content: buildMarkerContent(props.name, props.color),
      offset: new AMap.Pixel(0, 0),
      map: mapInstance,
    })
    mapState.value = 'ready'
  } catch (err) {
    console.warn('[ExplorePoiMiniMap] init failed:', err)
    mapState.value = 'error'
  }
}

function destroyMap() {
  if (marker) {
    try {
      mapInstance?.remove(marker)
    } catch {
      /* ignore */
    }
    marker = null
  }
  if (mapInstance) {
    try {
      mapInstance.destroy()
    } catch (err) {
      console.warn('[ExplorePoiMiniMap] destroy failed:', err)
    }
    mapInstance = null
  }
}

onMounted(() => {
  if (!props.coords) {
    mapState.value = 'no-coord'
    return
  }
  if (!containerRef.value) return
  // 懒加载：进入视口才实例化
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect()
        observer = null
        void initMap()
      }
    },
    { rootMargin: '120px 0px' },
  )
  observer.observe(containerRef.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  destroyMap()
})
</script>

<template>
  <div class="poi-mini-map">
    <div
      v-if="coords"
      ref="containerRef"
      class="poi-mini-map__canvas"
      :class="{
        'poi-mini-map__canvas--loading': mapState === 'loading' || mapState === 'idle',
      }"
    />
    <div v-else class="poi-mini-map__placeholder">
      该 POI 暂无精确坐标，点「看地图」在新页面查看
    </div>
    <div v-if="mapState === 'error'" class="poi-mini-map__overlay">
      地图加载失败
    </div>
    <div
      v-else-if="mapState === 'idle' || mapState === 'loading'"
      class="poi-mini-map__overlay poi-mini-map__overlay--soft"
    >
      地图加载中…
    </div>
  </div>
</template>

<style>
/* 用全局样式而不是 scoped：marker 内部的 HTML 是运行时插入的，
   scoped 的 [data-v-xxx] 选择器选不到。 */
.poi-mini-marker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 4px;
  background: rgba(255, 255, 255, 0.96);
  border-radius: 999px;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.18);
  font-size: 11px;
  color: #1f2937;
  white-space: nowrap;
  max-width: 220px;
  /* 让标签整体往上飘一点，圆点正好落在坐标处 */
  transform: translateY(-100%);
  pointer-events: none;
}

.poi-mini-marker__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.poi-mini-marker__label {
  text-overflow: ellipsis;
  overflow: hidden;
  max-width: 180px;
}
</style>

<style scoped>
.poi-mini-map {
  position: relative;
  width: 100%;
  height: 120px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-soft, var(--el-fill-color));
  border: 1px solid var(--line-soft, var(--el-border-color-lighter));
}

.poi-mini-map__canvas {
  width: 100%;
  height: 100%;
}

.poi-mini-map__canvas--loading {
  /* 占位时给个淡 placeholder 背景，避免实例化前一片空白 */
  background:
    linear-gradient(
      90deg,
      var(--el-fill-color) 0%,
      var(--el-fill-color-light) 50%,
      var(--el-fill-color) 100%
    );
  background-size: 200% 100%;
  animation: poi-mini-shimmer 1.4s ease-in-out infinite;
}

@keyframes poi-mini-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

.poi-mini-map__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  pointer-events: none;
}

.poi-mini-map__overlay--soft {
  background: rgba(255, 255, 255, 0.4);
}

.poi-mini-map__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
  padding: 0 12px;
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}
</style>
