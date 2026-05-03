<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import {
  Close,
  Search,
  Refresh,
  ArrowLeft,
  ArrowRight,
  MagicStick,
  MapLocation,
  Plus,
  Switch,
} from '@element-plus/icons-vue'
import {
  useItineraryStore,
  type ExploreCategory,
  type ExplorePoi,
} from '../store/useItineraryStore'
import { hasAMapKey } from '../utils/amapLoader'
import ExplorePoiMiniMap from './ExplorePoiMiniMap.vue'

/**
 * 探索面板：
 *   左侧城市/分类/数据源切换 + POI 卡片列表 + 翻页 / 换一批
 *
 * 三个动作：
 *   - 📍 看地图：调 store.focusPoiOnMap，由 DayMap watch exploreFocusPoi 处理
 *   - ➕ 插入：emit('insert', poi) 给 App.vue 打开"插哪天哪一格"的 picker
 *   - 🔄 替换：emit('replace', poi) 给 App.vue 打开"替换哪一项"的 picker
 *
 * 之所以把插入 / 替换的目标选择留给 App.vue：
 *   - 目标选择需要看完整 itinerary（"第 2 天 11:00 那项"），App.vue 已经有这个上下文
 *   - 这块 UI 是 dialog，跟 App.vue 现有 modify dialog 同源，复用样式更顺
 */

const emit = defineEmits<{
  (e: 'insert', poi: ExplorePoi): void
  (e: 'replace', poi: ExplorePoi): void
  (e: 'close'): void
}>()

const store = useItineraryStore()
const {
  exploreCity,
  exploreKeyword,
  exploreCategory,
  exploreSource,
  exploreItems,
  explorePage,
  exploreHasMore,
  exploreLoading,
  exploreError,
  exploreFromCache,
} = storeToRefs(store)

/** 城市输入框本地态：用户输入 → blur / 回车 才提交到 store，避免每个字符都重拉 */
const cityDraft = ref(exploreCity.value)
/** 关键词搜索框本地态：同样 blur/回车 才提交，避免连续重拉 */
const keywordDraft = ref(exploreKeyword.value)

watch(exploreCity, (val) => {
  cityDraft.value = val
})
watch(exploreKeyword, (val) => {
  keywordDraft.value = val
})

function commitCity() {
  const trimmed = cityDraft.value.trim()
  if (!trimmed) {
    ElMessage.warning('请输入要查询的城市名')
    return
  }
  void store.setExploreCity(trimmed)
}

/**
 * 关键词提交：
 * - 非空 → 走 store.setExploreKeyword（跨城、不限分类的精准搜索）
 * - 空且当前有关键词 → 等价于清除搜索，回到"按城市浏览"
 */
function commitKeyword() {
  const trimmed = keywordDraft.value.trim()
  if (trimmed === exploreKeyword.value) return
  void store.setExploreKeyword(trimmed)
}

function clearKeyword() {
  keywordDraft.value = ''
  if (exploreKeyword.value) {
    void store.clearExploreKeyword()
  }
}

/** 关键词搜索激活态：UI 用它来切换"分类 tabs"和"AI 切换"的可用性 */
const isSearching = computed(() => !!exploreKeyword.value.trim())

/**
 * 分类 tab：每个分类带一个柔和的 accent 色，作为左侧色块（替代 emoji）
 *   - 景点：苔绿
 *   - 美食：焦糖
 *   - 住宿：雾紫
 */
const categoryTabs: Array<{
  value: ExploreCategory
  label: string
  accent: string
}> = [
  { value: 'attraction', label: '景点', accent: '#5d8a6b' },
  { value: 'food', label: '美食', accent: '#c9874a' },
  { value: 'hotel', label: '住宿', accent: '#8a7aa6' },
]

function handleCategoryChange(cat: ExploreCategory) {
  store.setExploreCategory(cat)
}

function handleSourceChange(src: 'amap' | 'ai') {
  store.setExploreSource(src)
}

/**
 * 数据源切换：高德全量 vs AI 攻略
 * 不再依赖 emoji，标签改为短文字，hint 解释场景
 */
const sourceTabs: Array<{ value: 'amap' | 'ai'; label: string; hint: string }> = [
  {
    value: 'amap',
    label: '高德全量',
    hint: '基于高德地图实时检索，量多翻页快',
  },
  {
    value: 'ai',
    label: 'AI 精选',
    hint: '让 AI 联网精选 8 条，带停留时长和避坑 tips',
  },
]

const currentSourceHint = computed(
  () => sourceTabs.find((s) => s.value === exploreSource.value)?.hint ?? '',
)

const emptyHint = computed(() => {
  if (exploreLoading.value) return ''
  if (exploreError.value) return ''
  if (isSearching.value) {
    if (!exploreItems.value.length) {
      return `没找到与「${exploreKeyword.value}」匹配的地点`
    }
    return ''
  }
  if (!exploreCity.value.trim()) return '在上方输入城市名后开始浏览'
  if (!exploreItems.value.length) {
    return exploreSource.value === 'ai'
      ? '点击「换一批」让 AI 推荐'
      : '没找到符合条件的 POI，可换个分类试试'
  }
  return ''
})

/** POI 卡片左上角分类标签（与 categoryTabs 同款柔和色） */
function colorForCategory(cat: ExploreCategory): string {
  if (cat === 'attraction') return '#5d8a6b'
  if (cat === 'food') return '#c9874a'
  return '#8a7aa6'
}

/** 分类对应的中文短标签，用于 POI 卡片 / 缩略图 alt */
function categoryLabel(cat: ExploreCategory): string {
  return cat === 'attraction' ? '景点' : cat === 'food' ? '餐饮' : '住宿'
}

/** 全局是否启用缩略图：没配高德 Key 就完全不渲染（避免空占位浪费空间） */
const miniMapEnabled = hasAMapKey()

/** 高德 typename "风景名胜;公园广场;城市公园" 取最后一段最具体的，作为副标签 */
function shortType(typename?: string): string {
  if (!typename) return ''
  const segs = typename.split(/[;；,，]/).filter(Boolean)
  return segs[segs.length - 1] || ''
}

/**
 * "看地图"：在新 tab 打开高德页面，定位到该 POI。
 *
 * - amap source 有精确坐标 → 用 marker URL，落点准
 * - ai source 暂无坐标 → 用 search URL，让高德自己 geocode
 *
 * 同时把 POI 写进 store.focusPoiOnMap，给后续可能的"内嵌小地图"留接口。
 */
function handleFocusOnMap(poi: ExplorePoi) {
  store.focusPoiOnMap(poi)
  const name = encodeURIComponent(poi.name)
  let url: string
  if (poi.coords) {
    const { lng, lat } = poi.coords
    url = `https://uri.amap.com/marker?position=${lng},${lat}&name=${name}&src=shuozoujiuzou`
  } else {
    const city = encodeURIComponent(poi.cityname || store.exploreCity || '')
    url = `https://uri.amap.com/search?keyword=${name}${city ? `&city=${city}` : ''}&src=shuozoujiuzou`
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  ElMessage.success(`已在新页面打开「${poi.name}」的地图`)
}

function handleInsert(poi: ExplorePoi) {
  emit('insert', poi)
}

function handleReplace(poi: ExplorePoi) {
  emit('replace', poi)
}

function handleRefresh() {
  if (exploreSource.value === 'ai') {
    void store.refreshExploreFromAi()
  } else {
    void store.loadExplorePage(explorePage.value)
  }
}

function handleClose() {
  emit('close')
}
</script>

<template>
  <aside class="explore-panel">
    <header class="explore-panel__header">
      <div class="explore-panel__title">
        <span class="explore-panel__eyebrow">EXPLORE</span>
        <strong>探索景点</strong>
      </div>
      <button
        class="explore-panel__close"
        type="button"
        title="关闭"
        @click="handleClose"
      >
        <el-icon><Close /></el-icon>
      </button>
    </header>

    <div class="explore-panel__search">
      <el-input
        v-model="keywordDraft"
        size="default"
        placeholder="搜索地点：华东师范大学、外滩、宽窄巷子……"
        clearable
        :disabled="exploreLoading"
        @keyup.enter="commitKeyword"
        @blur="commitKeyword"
        @clear="clearKeyword"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </div>

    <div class="explore-panel__city-row">
      <span class="explore-panel__city-label">浏览城市</span>
      <el-input
        v-model="cityDraft"
        size="small"
        placeholder="如：北京 / 上海 / 大理"
        :disabled="exploreLoading"
        class="explore-panel__city-input"
        @keyup.enter="commitCity"
        @blur="commitCity"
      />
    </div>

    <div
      v-if="isSearching"
      class="explore-panel__searchbar"
    >
      <span class="explore-panel__searchbar-label">搜索结果</span>
      <span class="explore-panel__searchbar-keyword">{{ exploreKeyword }}</span>
      <button
        type="button"
        class="explore-panel__searchbar-clear"
        :disabled="exploreLoading"
        @click="clearKeyword"
      >
        <el-icon><Close /></el-icon>
        清除
      </button>
    </div>

    <div class="explore-panel__tabs">
      <button
        v-for="tab in categoryTabs"
        :key="tab.value"
        type="button"
        class="explore-tab"
        :class="{ 'explore-tab--active': !isSearching && exploreCategory === tab.value }"
        :disabled="exploreLoading || isSearching"
        :title="isSearching ? '搜索结果会包含所有类型，分类切换暂不可用' : ''"
        @click="handleCategoryChange(tab.value)"
      >
        <span class="explore-tab__dot" :style="{ background: tab.accent }" />
        <span>{{ tab.label }}</span>
      </button>
    </div>

    <div v-if="!isSearching" class="explore-panel__sources">
      <div class="source-toggle">
        <button
          v-for="src in sourceTabs"
          :key="src.value"
          type="button"
          class="source-toggle__btn"
          :class="{ 'source-toggle__btn--active': exploreSource === src.value }"
          :disabled="exploreLoading"
          @click="handleSourceChange(src.value)"
        >
          {{ src.label }}
        </button>
      </div>
      <p class="explore-panel__source-hint">{{ currentSourceHint }}</p>
    </div>

    <div class="explore-panel__list" v-loading="exploreLoading" element-loading-text="加载中…">
      <div
        v-if="exploreError"
        class="explore-panel__error"
      >
        <p>{{ exploreError }}</p>
        <el-button size="small" @click="handleRefresh">
          <el-icon><Refresh /></el-icon>
          再试一次
        </el-button>
      </div>

      <div v-else-if="emptyHint" class="explore-panel__empty">
        <p>{{ emptyHint }}</p>
        <el-button
          v-if="exploreSource === 'ai' && exploreCity"
          type="primary"
          plain
          size="small"
          @click="handleRefresh"
        >
          <el-icon><MagicStick /></el-icon>
          AI 攻略推荐
        </el-button>
      </div>

      <ul v-else class="explore-list">
        <li v-for="poi in exploreItems" :key="poi.id" class="explore-card">
          <ExplorePoiMiniMap
            v-if="miniMapEnabled && poi.coords"
            :coords="poi.coords"
            :name="poi.name"
            :color="colorForCategory(poi.category)"
          />

          <div class="explore-card__head">
            <span
              class="explore-card__chip"
              :style="{
                color: colorForCategory(poi.category),
                background: colorForCategory(poi.category) + '1f',
              }"
            >
              <span
                class="explore-card__chip-dot"
                :style="{ background: colorForCategory(poi.category) }"
              />
              {{ categoryLabel(poi.category) }}
            </span>
            <div class="explore-card__title-wrap">
              <h4 class="explore-card__name">{{ poi.name }}</h4>
              <div class="explore-card__meta">
                <span v-if="poi.source === 'amap'" class="explore-card__source">高德</span>
                <span v-else class="explore-card__source explore-card__source--ai">AI</span>
                <span v-if="poi.district">{{ poi.district }}</span>
                <span v-else-if="poi.cityname">{{ poi.cityname }}</span>
                <span v-if="shortType(poi.typename)">{{ shortType(poi.typename) }}</span>
              </div>
            </div>
          </div>

          <p class="explore-card__address">{{ poi.address }}</p>

          <p v-if="poi.description" class="explore-card__desc">{{ poi.description }}</p>

          <p v-if="poi.tips" class="explore-card__tips">
            <span class="explore-card__tips-label">小贴士</span>
            <span>{{ poi.tips }}</span>
          </p>

          <div v-if="poi.duration_minutes || poi.cost_estimate" class="explore-card__chips">
            <span v-if="poi.duration_minutes" class="explore-card__chip-stat">
              停留约 {{ Math.round(poi.duration_minutes / 60 * 10) / 10 }} 小时
            </span>
            <span v-if="poi.cost_estimate" class="explore-card__chip-stat">
              ¥{{ poi.cost_estimate }} 起
            </span>
          </div>

          <div class="explore-card__actions">
            <el-button size="small" plain @click="handleFocusOnMap(poi)">
              <el-icon><MapLocation /></el-icon>
              看地图
            </el-button>
            <el-button size="small" type="primary" plain @click="handleInsert(poi)">
              <el-icon><Plus /></el-icon>
              插入
            </el-button>
            <el-button size="small" plain class="explore-card__btn-replace" @click="handleReplace(poi)">
              <el-icon><Switch /></el-icon>
              替换
            </el-button>
          </div>
        </li>
      </ul>
    </div>

    <footer
      v-if="!exploreError && exploreItems.length"
      class="explore-panel__footer"
    >
      <template v-if="exploreSource === 'amap'">
        <el-button
          size="small"
          :disabled="explorePage <= 1 || exploreLoading"
          @click="store.prevExplorePage()"
        >
          <el-icon><ArrowLeft /></el-icon>
          上一页
        </el-button>
        <span class="explore-panel__page-num">第 {{ explorePage }} 页</span>
        <el-button
          size="small"
          :disabled="!exploreHasMore || exploreLoading"
          @click="store.nextExplorePage()"
        >
          下一页
          <el-icon><ArrowRight /></el-icon>
        </el-button>
      </template>
      <template v-else>
        <span v-if="exploreFromCache" class="explore-panel__cache-tag" title="该结果来自会话缓存，没有再调用 AI">
          已缓存
        </span>
        <el-button
          size="small"
          type="primary"
          plain
          :loading="exploreLoading"
          :title="exploreFromCache ? '点击重新调用 AI 拿新一批推荐（会消耗 token）' : '让 AI 再换一批推荐'"
          @click="handleRefresh"
        >
          <el-icon><Refresh /></el-icon>
          换一批 AI 推荐
        </el-button>
      </template>
    </footer>
  </aside>
</template>

<style scoped>
/* ============================================================
 * 探索面板：与主页一致的米色调 + 大圆角 + 弱阴影
 * 架构：sticky 卡片，header / city / tabs / source / list / footer 六段
 * ============================================================ */

.explore-panel {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius-card);
  border: 1px solid var(--line-soft);
  box-shadow: var(--shadow-card);
  overflow: hidden;
  position: sticky;
  top: 20px;
  max-height: calc(100vh - 40px);
}

.explore-panel__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 22px 22px 14px;
}

.explore-panel__title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.explore-panel__eyebrow {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--text-secondary);
}

.explore-panel__title strong {
  font-size: 19px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.explore-panel__close {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--surface-soft);
  border-radius: 10px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background 0.15s ease, color 0.15s ease;
}

.explore-panel__close:hover {
  background: var(--surface-sunken);
  color: var(--text-primary);
}

.explore-panel__search {
  padding: 0 22px 10px;
}

.explore-panel__city-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 22px 12px;
}

.explore-panel__city-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--text-secondary);
  text-transform: uppercase;
  flex-shrink: 0;
}

.explore-panel__city-input {
  flex: 1;
  min-width: 0;
}

/* 搜索结果状态条：搜索激活后告诉用户当前看的是哪个关键词、提供清除入口 */
.explore-panel__searchbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 22px 12px;
  padding: 8px 12px;
  background: var(--accent-yellow-soft, #f5ecd7);
  border: 1px solid var(--accent-yellow, #d4a84e);
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--text-primary);
}

.explore-panel__searchbar-label {
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.explore-panel__searchbar-keyword {
  flex: 1;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.explore-panel__searchbar-clear {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.explore-panel__searchbar-clear:hover:not(:disabled) {
  background: rgba(31, 28, 25, 0.08);
  color: var(--text-primary);
}

.explore-panel__searchbar-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 分类 tab：原 emoji → 替换为左侧色点；选中态米白底 + 深色字 */
.explore-panel__tabs {
  display: flex;
  gap: 6px;
  padding: 0 22px 14px;
}

.explore-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 4px;
  border: 1px solid var(--line-soft);
  background: var(--surface);
  border-radius: 12px;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  color: var(--text-secondary);
  transition: all 0.15s ease;
}

.explore-tab:hover:not(:disabled) {
  border-color: var(--line);
  color: var(--text-primary);
}

.explore-tab--active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-on-dark);
  font-weight: 600;
}

.explore-tab:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.explore-tab__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* —— 数据源切换：分段控件（米白底 + 选中态白卡） —— */
.explore-panel__sources {
  padding: 0 22px 14px;
}

.source-toggle {
  display: flex;
  background: var(--surface-sunken);
  border-radius: 12px;
  padding: 4px;
  gap: 2px;
}

.source-toggle__btn {
  flex: 1;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  transition: all 0.15s ease;
  white-space: nowrap;
}

.source-toggle__btn:hover:not(:disabled) {
  color: var(--text-primary);
}

.source-toggle__btn--active {
  background: var(--surface);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(31, 28, 25, 0.08);
}

.source-toggle__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.explore-panel__source-hint {
  margin: 8px 4px 0;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.explore-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 18px 18px;
  min-height: 0;
}

.explore-panel__error,
.explore-panel__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  gap: 14px;
}

.explore-panel__error p {
  color: var(--accent-coral);
  margin: 0;
}

.explore-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* —— POI 卡片：白底大圆角，hover 提升阴影 —— */
.explore-card {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card-sm);
  padding: 14px;
  background: var(--surface);
  transition: border-color 0.18s ease, box-shadow 0.18s ease,
    transform 0.18s ease;
}

.explore-card:hover {
  border-color: var(--line);
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-1px);
}

.explore-card__head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-top: 8px;
}

.explore-card__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  font-size: 11.5px;
  font-weight: 600;
  flex-shrink: 0;
  letter-spacing: 0.02em;
}

.explore-card__chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.explore-card__title-wrap {
  flex: 1;
  min-width: 0;
}

.explore-card__name {
  margin: 0 0 4px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
  letter-spacing: -0.005em;
  word-break: break-word;
}

.explore-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-secondary);
  line-height: 1.4;
}

/* "高德/AI" 标签：用 monochrome 风格，配色不抢主色 */
.explore-card__source {
  display: inline-block;
  background: var(--surface-sunken);
  color: var(--text-regular);
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.explore-card__source--ai {
  background: var(--accent);
  color: var(--text-on-dark);
}

.explore-card__address {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--text-regular);
  line-height: 1.55;
}

.explore-card__desc {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--text-regular);
  line-height: 1.6;
}

.explore-card__tips {
  margin: 8px 0 0;
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 12px;
  background: var(--accent-yellow-soft);
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.55;
  color: #5c4a18;
}

.explore-card__tips-label {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--accent);
}

.explore-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.explore-card__chip-stat {
  font-size: 11.5px;
  padding: 3px 10px;
  background: var(--surface-soft);
  color: var(--text-secondary);
  border-radius: var(--radius-pill);
  font-variant-numeric: tabular-nums;
}

.explore-card__actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.explore-card__actions .el-button {
  flex: 1;
  min-width: 0;
}

/* "替换"按钮：使用珊瑚色描边强调，但不抢主 CTA */
.explore-card__btn-replace {
  --el-button-text-color: var(--accent-coral);
  --el-button-border-color: var(--accent-coral-soft);
  --el-button-hover-text-color: var(--accent-coral);
  --el-button-hover-border-color: var(--accent-coral);
  --el-button-hover-bg-color: rgba(236, 111, 90, 0.08);
}

.explore-panel__footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid var(--line-soft);
  background: var(--surface-soft);
}

.explore-panel__page-num {
  font-size: 12.5px;
  color: var(--text-secondary);
  min-width: 60px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.explore-panel__cache-tag {
  font-size: 11px;
  padding: 3px 10px;
  background: var(--accent-yellow-soft);
  color: #5c4a18;
  border-radius: var(--radius-pill);
  font-weight: 600;
  white-space: nowrap;
}
</style>
