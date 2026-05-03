import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  generateItinerary,
  generateExploreSuggestions,
  modifyItinerary,
  type ExploreCategory,
  type ExploreSuggestion,
  type ModifyScope,
} from '../api/llmService'
import { readStorage, removeStorage, writeStorage } from '../utils/storage'
import {
  clearAllFailedGeocodes,
  estimateFare,
  geocodeBatch,
  getCachedGeocode,
  getCachedRoute,
  inferCityFromText,
  planRoute,
  searchAnyPois,
  searchCityPois,
  type GeocodeBatchProgress,
  type GeocodeResult,
} from '../api/amapService'
import {
  hasAMapKey,
  roughDistanceKm,
  type TransitMode,
} from '../utils/amapLoader'

export type ActivityType = 'attraction' | 'food' | 'transit' | 'hotel'

export interface Activity {
  time: string
  type: ActivityType
  /** 人类可读的地点名（如"故宫博物院"），用于 UI 展示 */
  location: string
  /**
   * 完整结构化地址（如"北京市东城区景山前街4号"）。
   * 由 LLM 联网搜索后给出，地图组件优先用它做 Geocoder 查询，识别率近 100%。
   * 旧数据可能没有此字段，UI 与 service 必须做兼容。
   */
  address?: string
  /**
   * 建议在该节点停留的时长（分钟）。
   * LLM 基于真实游玩时长（参考小红书/官网）给出，用于:
   *   1. UI 展示「⏱ 约 1.5 小时」
   *   2. 让 LLM 自己按 duration 推 time，避免"用餐 2.5 小时"的不合理排程
   * 旧数据可能没有，UI 端做兜底默认值（食 60 / 景 120 / 宿 720 / 长途交通 60）
   */
  duration_minutes?: number
  description: string
  cost_estimate: number
  tips: string
}

export interface DayPlan {
  day: number
  date_label: string
  activities: Activity[]
}

export interface Itinerary {
  trip_title: string
  total_budget_estimate: number
  summary: string
  days: DayPlan[]
}

/**
 * 一份历史行程的快照。区别于 itinerary 本身，多保留：
 * - id: 唯一键，用于切换/删除
 * - createdAt: 排序 + 展示
 * - prompt: 用户当时的输入诉求，方便用户回忆「我当时让 AI 干嘛了」
 */
export interface HistoryEntry {
  id: string
  createdAt: number
  prompt: string
  itinerary: Itinerary
}

/**
 * 探索面板里的一条 POI。统一了高德 PlaceSearch 与 LLM 攻略推荐的结构差异，
 * 让 ExplorePanel.vue 不用关心数据来源、可以一致地"插入 / 替换 / 看地图"。
 *
 * - source = 'amap'：必有 coords；description / tips 通常缺失（用 typename / district 顶替展示）
 * - source = 'ai'：可能没有 coords（要靠后续 geocode 拿到）；duration / cost / tips 由模型给出
 */
export interface ExplorePoi {
  id: string
  name: string
  address: string
  category: ExploreCategory
  source: 'amap' | 'ai'
  coords?: { lng: number; lat: number }
  /** 高德返回的类型描述，例如 "风景名胜;公园广场;城市公园" */
  typename?: string
  /** 区县名，列表里展示便于用户判断地段 */
  district?: string
  cityname?: string
  /** 模型/默认建议的停留分钟数；用于"插入"时自动填 duration_minutes */
  duration_minutes?: number
  /** 单价/人均预估，元 */
  cost_estimate?: number
  description?: string
  tips?: string
}

/**
 * 空行程：用户首次进入 / 重置后的占位状态。
 * UI 通过 `hasGenerated || days.length > 0` 判断要不要展示空态卡片。
 */
const EMPTY_ITINERARY: Itinerary = {
  trip_title: '',
  total_budget_estimate: 0,
  summary: '',
  days: [],
}

/**
 * 用 "{dayIndex}-{activityIndex}" 唯一标识一个被修改中的活动节点
 */
export type ModifyKey = `${number}-${number}`

export function makeModifyKey(
  dayIndex: number,
  activityIndex: number,
): ModifyKey {
  return `${dayIndex}-${activityIndex}`
}

// ==================== 类型自纠正 ====================
// LLM 偶尔会把"今晚到达的高铁站 / 机场"当成"今晚住此"标记成 hotel，
// 也会把交通枢纽误标为 attraction。我们在数据进入 UI 前做一道兜底纠正：
// 名字一看就是交通枢纽（火车站/高铁站/机场/码头 等）时，强制改成 transit。
// 这样旧的持久化数据、历史记录、新生成的行程都能统一受益。

const HOTEL_KEYWORDS = /(酒店|宾馆|客栈|民宿|公寓|旅馆|度假村|青年旅社|hostel|hotel|inn|resort)/i

/**
 * 判断一个 location 名称是否明显是交通枢纽。
 * 命中条件：
 *   1. 名称含 火车站/高铁站/动车站/汽车站/客运站/巴士站/地铁站/航站楼/机场/码头 等关键词
 *   2. 或形如 "XX站"（去除常见住宿关键词后）：例如 "平潭站""北京南站""虹桥站"
 */
export function looksLikeTransitHub(location: string | undefined | null): boolean {
  if (!location) return false
  const name = location.trim()
  if (!name) return false
  if (
    /(火车站|高铁站|动车站|汽车站|客运站|长途客运|长途汽车|巴士站|地铁站|轻轨站|航站楼|机场|码头)/.test(
      name,
    )
  ) {
    return true
  }
  // 形如 "平潭站""上海虹桥站"——以"站"结尾，且不含明显住宿词
  if (/.+站$/.test(name) && !HOTEL_KEYWORDS.test(name)) {
    return true
  }
  return false
}

/**
 * 扫描一份行程，把"明显是交通枢纽却被打成非 transit"的节点改回 transit。
 * 没有任何节点需要修改时返回原引用，便于上层用 === 判断是否要回写。
 */
export function correctActivityTypes(it: Itinerary): Itinerary {
  let touched = false
  const days = it.days.map((day) => {
    let dayTouched = false
    const activities = day.activities.map((a) => {
      if (a.type !== 'transit' && looksLikeTransitHub(a.location)) {
        dayTouched = true
        return { ...a, type: 'transit' as ActivityType }
      }
      return a
    })
    if (dayTouched) {
      touched = true
      return { ...day, activities }
    }
    return day
  })
  return touched ? { ...it, days } : it
}

/**
 * 比较修改前后两份行程，返回所有"内容发生变化"的 (dayIdx, actIdx) ModifyKey 集合。
 *
 * 用于 P3「联动修改」高亮：用户主动修改的目标 keys 已经在 modifyingKeys 里，
 * 把"全部变化 keys"减去"用户目标 keys"就剩下 AI 顺手联动调整的节点。
 *
 * 实现说明：
 * - 按 (dayIdx, actIdx) 对齐，序列化字段后做字符串比较，简单可靠
 * - day 数量或当天 activities 数量变化的部分，整段视为已改
 * - 不区分字段——任何差异都算"变化"
 */
export function diffActivityKeys(pre: Itinerary, post: Itinerary): Set<ModifyKey> {
  const out = new Set<ModifyKey>()
  const maxDays = Math.max(pre.days.length, post.days.length)
  for (let d = 0; d < maxDays; d++) {
    const preDay = pre.days[d]
    const postDay = post.days[d]
    if (!preDay || !postDay) {
      // 整天被增删，标整天
      const day = preDay ?? postDay
      day?.activities.forEach((_, i) => out.add(makeModifyKey(d, i)))
      continue
    }
    const maxActs = Math.max(preDay.activities.length, postDay.activities.length)
    for (let a = 0; a < maxActs; a++) {
      const preAct = preDay.activities[a]
      const postAct = postDay.activities[a]
      if (!preAct || !postAct) {
        out.add(makeModifyKey(d, a))
        continue
      }
      // 关键字段任意一处不一致就算 changed
      if (
        preAct.time !== postAct.time ||
        preAct.type !== postAct.type ||
        preAct.location !== postAct.location ||
        (preAct.address ?? '') !== (postAct.address ?? '') ||
        (preAct.duration_minutes ?? 0) !== (postAct.duration_minutes ?? 0) ||
        preAct.description !== postAct.description ||
        preAct.cost_estimate !== postAct.cost_estimate ||
        preAct.tips !== postAct.tips
      ) {
        out.add(makeModifyKey(d, a))
      }
    }
  }
  return out
}

// ==================== localStorage keys ====================
const KEY_ITINERARY = 'itinerary'
const KEY_PROMPT = 'userPrompt'
const KEY_HISTORY = 'history'
const KEY_HAS_GENERATED = 'hasGenerated'
const KEY_CHOSEN_MODES = 'chosenModes'
const KEY_UNDO_STACK = 'undoStack'
const KEY_REDO_STACK = 'redoStack'

const HISTORY_LIMIT = 10
/**
 * 撤销 / 重做栈最大深度。
 * 单份行程序列化后通常 5~20KB，20 步上限即便是大行程也只占 ~400KB，
 * 远低于 localStorage 5MB 上限；更深的话价值递减（用户极少回退十几步）。
 */
const UNDO_DEPTH = 20

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export const useItineraryStore = defineStore('itinerary', () => {
  // ============ 持久化恢复 ============
  // hasGenerated 用来区分：当前 itinerary 是用户真生成过的，还是空的初始状态。
  // 没生成过时，UI 显示空态引导；生成过则展示完整时间线。
  const hasGenerated = ref<boolean>(readStorage(KEY_HAS_GENERATED, false))

  // 持久化的旧数据可能含被 LLM 误标的交通枢纽（如"平潭站"被打成 hotel），
  // 加载时立刻跑一遍自纠正，避免界面上看到错误的"住宿"标签。
  //
  // 迁移逻辑：早期版本会把 mock 示例行程写进 localStorage，但 hasGenerated=false。
  // 那种 stale 数据现在应当被清空，避免老用户回来看到陈旧示例当作"自己生成的"。
  const storedItinerary = readStorage<Itinerary>(KEY_ITINERARY, EMPTY_ITINERARY)
  const itinerary = ref<Itinerary>(
    !hasGenerated.value && storedItinerary.days.length > 0
      ? EMPTY_ITINERARY
      : correctActivityTypes(storedItinerary),
  )
  const userPrompt = ref<string>(readStorage(KEY_PROMPT, ''))
  const history = ref<HistoryEntry[]>(
    readStorage<HistoryEntry[]>(KEY_HISTORY, []).map((h) => {
      const fixed = correctActivityTypes(h.itinerary)
      return fixed === h.itinerary ? h : { ...h, itinerary: fixed }
    }),
  )

  /**
   * 用户为每个「过渡段」选定的交通方式。
   * key: "dayIndex-fromActivityIndex"  (to 总是 from+1)
   * value: TransitMode
   * 持久化，刷新不丢；切换历史时也保留全局选择
   */
  const chosenModes = ref<Record<string, TransitMode>>(
    readStorage<Record<string, TransitMode>>(KEY_CHOSEN_MODES, {}),
  )

  const isGenerating = ref<boolean>(false)
  /**
   * 当前正在被微调的活动 key 集合。空集表示没有微调进行中。
   * 多节点 / 整天 / 整体修改时，集合内可能包含多个 key，
   * UI 据此把每张被改动卡片打上 v-loading 遮罩。
   */
  const modifyingKeys = ref<Set<ModifyKey>>(new Set())
  /** 当前修改的作用域 kind，用于 UI 区分单/多/整天/整体的提示文案 */
  const modifyingScopeKind = ref<'single' | 'multiple' | 'day' | 'whole' | null>(null)
  const isModifying = computed(() => modifyingKeys.value.size > 0)
  /** 是否有任何 LLM 请求在跑（生成 / 微调） */
  const isBusy = computed(() => isGenerating.value || isModifying.value)

  /**
   * 「AI 联动调整」高亮集合。
   * - 仅在 single / multiple 修改成功后填充：用户没主动选、但 AI 顺手改了的相邻节点。
   * - 5 秒后由 setTimeout 自动清空，保留期间 UI 给这些卡片打"🔗 已联动"浮标。
   * - 用户撤销 / 重做 / 切换历史 / 重新生成时也会立刻清空，避免陈旧状态混淆。
   */
  const cascadeKeys = ref<Set<ModifyKey>>(new Set())
  /** 上一次修改的总结，用于 toolbar hint 的"主改 X 项 + 联动 Y 项"提示 */
  const lastModifySummary = ref<{
    primaryCount: number
    cascadeCount: number
    scopeKind: 'single' | 'multiple' | 'day' | 'whole'
    at: number
  } | null>(null)
  /** 5 秒后清空联动高亮的 timer 句柄，下一次修改时清掉旧 timer，避免提前淡出 */
  let cascadeClearTimer: ReturnType<typeof setTimeout> | null = null
  const CASCADE_HOLD_MS = 6000

  function clearCascadeHighlight() {
    if (cascadeClearTimer !== null) {
      clearTimeout(cascadeClearTimer)
      cascadeClearTimer = null
    }
    cascadeKeys.value = new Set()
    lastModifySummary.value = null
  }

  /**
   * 撤销栈：保存历次 commit 之前的行程快照，**栈尾是最近的旧版本**。
   * 重做栈：每次撤销时把"撤销前"的版本压入，重做时弹回当前。
   * 任何修改类操作（modifyActivity / 探索面板的插入替换 / 整天改 / 整体改）
   * 都通过 commitChange 入栈，新操作会清空 redoStack（线性历史）。
   */
  const undoStack = ref<Itinerary[]>(
    (readStorage<Itinerary[]>(KEY_UNDO_STACK, []) ?? []).map(correctActivityTypes),
  )
  const redoStack = ref<Itinerary[]>(
    (readStorage<Itinerary[]>(KEY_REDO_STACK, []) ?? []).map(correctActivityTypes),
  )
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  /** 生成 / 微调请求的 AbortController，用于让 UI 一键取消 */
  let activeController: AbortController | null = null

  // ============ 类型自纠正：兜底 LLM 偶尔把交通枢纽标成 hotel/attraction ============
  // 在持久化 watch 之前注册，确保被纠正后写入磁盘的也是修正后的数据。
  // correctActivityTypes 不变时会返回同一引用，触发 === 判断后短路，避免无限循环。
  watch(itinerary, (val) => {
    const corrected = correctActivityTypes(val)
    if (corrected !== val) itinerary.value = corrected
  })

  // ============ 持久化订阅 ============
  // deep watch 让 itinerary 内部任何变化都会被存盘（虽然我们目前是整体替换）
  watch(itinerary, (val) => writeStorage(KEY_ITINERARY, val), { deep: true })
  watch(userPrompt, (val) => writeStorage(KEY_PROMPT, val))
  watch(history, (val) => writeStorage(KEY_HISTORY, val), { deep: true })
  watch(hasGenerated, (val) => writeStorage(KEY_HAS_GENERATED, val))
  watch(chosenModes, (val) => writeStorage(KEY_CHOSEN_MODES, val), { deep: true })
  watch(undoStack, (val) => writeStorage(KEY_UNDO_STACK, val), { deep: true })
  watch(redoStack, (val) => writeStorage(KEY_REDO_STACK, val), { deep: true })

  // ============ 地图相关：geocode 状态版本号 ============
  // 让组件可以 watch 这个数字感知"任意 geocode 完成"，从而无需在 store 维护
  // 庞大的 reactive cache（cache 自身在 amapService 模块内）
  const geocodeRevision = ref(0)
  const routeRevision = ref(0)
  /**
   * 是否有「批量 geocoding 任务」正在跑。
   * UI 用它统一显示"识别中…"，避免每个组件各自维护 ref 但又互相不知道。
   * 顺便防止用户疯狂连点重试按钮触发重复请求。
   */
  const isGeocodingBatch = ref(false)
  /**
   * 当前批量 geocoding 的进度，给 UI 做"3/8 已完成"和动效。
   * 没有任务时 total=0；任务结束后保持最后一帧（done=total），方便 UI 收尾。
   */
  const geocodingProgress = ref<GeocodeBatchProgress>({ done: 0, total: 0, inFlight: [] })

  /**
   * 单节点城市提示：优先从 address 提取（最准确），
   * 再退回 location，最后用整趟行程的城市提示。
   */
  function cityHintForActivity(act: Activity, tripCityHint?: string): string | undefined {
    return inferCityFromText(act.address, act.location, tripCityHint)
  }

  /**
   * 收集当前行程里"还没成功 geocode"的所有节点，去重。
   * triggerGeocodeForCurrent + retryFailedGeocodes 共用此逻辑。
   */
  function collectPendingGeocodeItems(): Array<{
    location: string
    cityHint?: string
    address?: string
  }> {
    const trip = itinerary.value
    const cityHint = inferCityFromText(trip.trip_title, trip.summary)
    const items: Array<{ location: string; cityHint?: string; address?: string }> = []
    const seen = new Set<string>()
    for (const day of trip.days) {
      for (const act of day.activities) {
        const loc = act.location?.trim()
        if (!loc) continue
        const addr = act.address?.trim()
        const actCityHint = cityHintForActivity(act, cityHint)
        const dedupKey = `${actCityHint ?? ''}|${addr ?? ''}|${loc}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        const cached = getCachedGeocode(loc, actCityHint, addr)
        if (cached?.status === 'ok') continue
        items.push({ location: loc, cityHint: actCityHint, address: addr })
      }
    }
    return items
  }

  /**
   * 行程切换时主动批量编码（异步，不阻塞 UI）。
   * 用 isGeocodingBatch 防重入，避免 watch 反复触发并发跑。
   */
  function triggerGeocodeForCurrent() {
    if (!hasAMapKey()) return
    if (isGeocodingBatch.value) return
    const items = collectPendingGeocodeItems()
    if (!items.length) {
      geocodeRevision.value += 1
      void preloadWalkingRoutes()
      return
    }
    isGeocodingBatch.value = true
    geocodingProgress.value = { done: 0, total: items.length, inFlight: [] }
    void geocodeBatch(
      items,
      () => {
        geocodeRevision.value += 1
      },
      undefined,
      (p) => {
        geocodingProgress.value = p
      },
    )
      .catch((err) => {
        console.error('[store] geocodeBatch threw:', err)
      })
      .finally(() => {
        isGeocodingBatch.value = false
        void preloadWalkingRoutes()
      })
  }

  /**
   * 预加载步行路径：默认显示步行用时，提前查好让用户切换到天 view 时秒显。
   * 公交/驾车/骑行 lazy on tab click（避免无效配额消耗）。
   * 距离明显超过 10km 的步行段直接跳过。
   */
  async function preloadWalkingRoutes() {
    if (!hasAMapKey()) return
    const trip = itinerary.value
    const cityHint = inferCityFromText(trip.trip_title, trip.summary)
    const tasks: Array<Promise<unknown>> = []
    for (const day of trip.days) {
      for (let i = 0; i < day.activities.length - 1; i++) {
        const a = day.activities[i]
        const b = day.activities[i + 1]
        const cityHintA = cityHintForActivity(a, cityHint)
        const cityHintB = cityHintForActivity(b, cityHint)
        const pairCityHint = inferCityFromText(cityHintA, cityHintB, cityHint)
        const ca = getCachedGeocode(a.location, cityHintA, a.address)
        const cb = getCachedGeocode(b.location, cityHintB, b.address)
        if (ca?.status !== 'ok' || cb?.status !== 'ok' || !ca.coords || !cb.coords) continue
        const km = roughDistanceKm(ca.coords, cb.coords)
        if (km > 10) continue
        tasks.push(
          planRoute(ca.coords, cb.coords, 'walking', pairCityHint).then(() => {
            routeRevision.value += 1
          }),
        )
      }
    }
    await Promise.all(tasks)
  }

  // 行程一变，立刻触发批量编码
  watch(
    itinerary,
    () => {
      triggerGeocodeForCurrent()
    },
    { immediate: true, deep: false },
  )

  function bumpRouteRevision() {
    routeRevision.value += 1
  }

  /**
   * 用户主动点击"重试识别"。
   *
   * 设计要点：
   * 1. 先清掉所有非 ok 缓存（fail / pending），让 geocodeBatch 走全新流程。
   * 2. 用 isGeocodingBatch 防重入，疯狂连点不会触发并发请求。
   * 3. 内部加 60s 兜底超时：即便高德全 hang，UI 也能在 60s 后恢复点击状态。
   */
  async function retryFailedGeocodes(): Promise<{
    retried: number
    succeeded: number
    timedOut?: boolean
  }> {
    if (!hasAMapKey()) return { retried: 0, succeeded: 0 }
    if (isGeocodingBatch.value) {
      // 已经在跑了，告诉调用方"没新增重试"
      return { retried: 0, succeeded: 0 }
    }

    clearAllFailedGeocodes()
    const items = collectPendingGeocodeItems()
    if (!items.length) {
      geocodeRevision.value += 1
      return { retried: 0, succeeded: 0 }
    }

    isGeocodingBatch.value = true
    geocodingProgress.value = { done: 0, total: items.length, inFlight: [] }
    let succeeded = 0
    let timedOut = false
    try {
      // 40s 总兜底超时：单点已 15s 超时 + 并发 4，batch 通常 5-15s 完成。
      // 40s 是兜底，确保按钮 spinner 永远不会无限转。
      const RETRY_TOTAL_TIMEOUT_MS = 40_000
      const batchPromise = geocodeBatch(
        items,
        (_loc, result) => {
          if (result.status === 'ok') succeeded += 1
          geocodeRevision.value += 1
        },
        undefined,
        (p) => {
          geocodingProgress.value = p
        },
      )
      const timeoutPromise = new Promise<'TIMEOUT'>((resolve) =>
        setTimeout(() => resolve('TIMEOUT'), RETRY_TOTAL_TIMEOUT_MS),
      )
      const r = await Promise.race([batchPromise.then(() => 'DONE' as const), timeoutPromise])
      if (r === 'TIMEOUT') {
        timedOut = true
        console.warn('[store] retryFailedGeocodes timed out after 40s')
      }
    } finally {
      isGeocodingBatch.value = false
    }
    void preloadWalkingRoutes()
    return { retried: items.length, succeeded, timedOut }
  }

  // ============ 交通方式选择 + 总交通费 ============

  /**
   * 按直线距离推荐合理的默认交通方式。
   * UI 默认就用这个推荐值，避免出现"步行 50km" 这种 disabled 选择。
   *
   * - < 1.2km  → walking
   * - 1.2~8km  → transit（公交/地铁，覆盖城市内中距离最常用场景）
   * - > 8km    → driving（城际或长距离，公交可能转车多次）
   */
  function recommendModeByKm(km: number | undefined): TransitMode {
    if (km === undefined) return 'walking'
    if (km < 1.2) return 'walking'
    if (km < 8) return 'transit'
    return 'driving'
  }

  function modeKey(dayIndex: number, fromIndex: number): string {
    return `${dayIndex}-${fromIndex}`
  }

  /**
   * 取用户为某段选择的交通方式。
   * - 用户没选过 → 用 defaultMode（调用方按距离智能推荐）
   * - 用户选过任意 mode（含智能默认）→ 沿用用户选的，刷新/切历史都保留
   */
  function getChosenMode(
    dayIndex: number,
    fromIndex: number,
    defaultMode: TransitMode = 'walking',
  ): TransitMode {
    return chosenModes.value[modeKey(dayIndex, fromIndex)] ?? defaultMode
  }

  /**
   * 持久化用户的 mode 选择。
   * 始终写入（不再 delete 默认值），让"已选过"和"用智能默认"两种语义清晰可辨。
   */
  function setChosenMode(dayIndex: number, fromIndex: number, mode: TransitMode) {
    chosenModes.value = {
      ...chosenModes.value,
      [modeKey(dayIndex, fromIndex)]: mode,
    }
  }

  /**
   * 当前行程的总交通费估算（依赖 chosenModes + routeRevision + geocodeRevision）。
   * 仅统计「已成功 geocode + 已查到路径」的过渡段；其他段视为未知不计入。
   */
  /**
   * 总游玩时长（分钟）：把所有 activity.duration_minutes 累加。
   * 旧数据 / hotel 等没填或填 0 的不计入。
   */
  const totalDurationMinutes = computed(() => {
    let total = 0
    for (const day of itinerary.value.days) {
      for (const act of day.activities) {
        const d = Number(act.duration_minutes ?? 0)
        if (Number.isFinite(d) && d > 0 && act.type !== 'hotel') {
          total += d
        }
      }
    }
    return total
  })

  const transitCostEstimate = computed(() => {
    void routeRevision.value
    void geocodeRevision.value
    const trip = itinerary.value
    const cityHint = inferCityFromText(trip.trip_title, trip.summary)
    let total = 0
    let countedSegments = 0
    let totalSegments = 0
    for (let dayIdx = 0; dayIdx < trip.days.length; dayIdx++) {
      const day = trip.days[dayIdx]
      for (let i = 0; i < day.activities.length - 1; i++) {
        totalSegments += 1
        const from = day.activities[i]
        const to = day.activities[i + 1]
        const cityHintFrom = cityHintForActivity(from, cityHint)
        const cityHintTo = cityHintForActivity(to, cityHint)
        const cf = getCachedGeocode(from.location, cityHintFrom, from.address)
        const ct = getCachedGeocode(to.location, cityHintTo, to.address)
        if (cf?.status !== 'ok' || ct?.status !== 'ok' || !cf.coords || !ct.coords) continue
        // 同地点不计费
        const km = roughDistanceKm(cf.coords, ct.coords)
        if (km < 0.05) {
          countedSegments += 1
          continue
        }
        // 与 RouteSegment UI 共用同一智能默认，确保汇总价 = 用户看到的各段价之和
        const mode = getChosenMode(dayIdx, i, recommendModeByKm(km))
        const route = getCachedRoute(cf.coords, ct.coords, mode)
        if (route?.status !== 'ok') continue
        const fareCity = ct.coords.city ?? cf.coords.city ?? cityHint
        const { fare } = estimateFare(mode, route.distance, fareCity)
        total += fare
        countedSegments += 1
      }
    }
    return {
      total,
      countedSegments,
      totalSegments,
      complete: countedSegments === totalSegments,
    }
  })

  function setItinerary(next: Itinerary) {
    itinerary.value = next
  }

  /**
   * 把一份新的行程"提交"为可撤销的修改：
   * - 当前 itinerary 进 undoStack
   * - 清空 redoStack（线性历史，新操作会让"未来分支"作废）
   * - undoStack 超出 UNDO_DEPTH 时砍掉最旧的，保证内存可控
   *
   * 所有修改类入口（modifyActivity / 探索面板插入替换 / 整天改 / 整体改）
   * 都应该通过这个函数写入，不要直接赋值 itinerary.value，否则撤销栈会漏记。
   */
  function commitChange(next: Itinerary) {
    const snapshot = itinerary.value
    if (snapshot === next) return
    undoStack.value = [...undoStack.value, snapshot].slice(-UNDO_DEPTH)
    redoStack.value = []
    itinerary.value = next
  }

  /**
   * 撤销最近一次 commit。把当前版本压入 redoStack 后，恢复 undoStack 末尾的旧版本。
   * 微调进行中禁止撤销，避免覆盖正在写入的新数据。
   */
  function undo(): boolean {
    if (isModifying.value) return false
    if (undoStack.value.length === 0) return false
    const prev = undoStack.value[undoStack.value.length - 1]
    redoStack.value = [...redoStack.value, itinerary.value].slice(-UNDO_DEPTH)
    undoStack.value = undoStack.value.slice(0, -1)
    itinerary.value = prev
    // 撤销 / 重做后，"AI 联动"高亮和上次修改总结都对不上号了，立刻清掉
    clearCascadeHighlight()
    return true
  }

  /**
   * 重做最近一次撤销。和 undo 镜像：把当前版本压入 undoStack，
   * 恢复 redoStack 末尾的"未来版本"。
   */
  function redo(): boolean {
    if (isModifying.value) return false
    if (redoStack.value.length === 0) return false
    const next = redoStack.value[redoStack.value.length - 1]
    undoStack.value = [...undoStack.value, itinerary.value].slice(-UNDO_DEPTH)
    redoStack.value = redoStack.value.slice(0, -1)
    itinerary.value = next
    clearCascadeHighlight()
    return true
  }

  /**
   * 清空两个栈。在"整体替换"行程的场景下调用——
   * 比如「全新生成」「切换历史行程」「撤销栈和新行程对不上号了」。
   */
  function clearUndoRedo() {
    undoStack.value = []
    redoStack.value = []
    clearCascadeHighlight()
  }

  /** 把当前行程清空回到空态：清掉生成痕迹、撤销栈、交通选择，历史保留不动 */
  function resetItinerary() {
    itinerary.value = EMPTY_ITINERARY
    clearUndoRedo()
    hasGenerated.value = false
    chosenModes.value = {}
  }

  /**
   * 判断给定坐标的活动当前是否正处于微调中（用于 UI v-loading 绑定）。
   * 多节点 / 整天 / 整体修改时，集合内的所有节点都会被判定为正在微调。
   */
  function isActivityModifying(
    dayIndex: number,
    activityIndex: number,
  ): boolean {
    return modifyingKeys.value.has(makeModifyKey(dayIndex, activityIndex))
  }

  /**
   * 记录一份历史快照。新条目永远放头部，超过上限自动截断。
   * 如果最近一条 prompt 完全一样且生成时间 < 5 分钟，认为是用户在重试
   * 同一个想法，不再重复入库（避免历史被废稿撑爆）
   */
  function pushHistory(entry: { prompt: string; itinerary: Itinerary }) {
    const now = Date.now()
    const last = history.value[0]
    const isDuplicateRetry =
      last &&
      last.prompt.trim() === entry.prompt.trim() &&
      now - last.createdAt < 5 * 60 * 1000
    if (isDuplicateRetry) {
      // 用更新的结果替换上一条
      history.value = [
        {
          id: last.id,
          createdAt: now,
          prompt: entry.prompt,
          itinerary: entry.itinerary,
        },
        ...history.value.slice(1),
      ]
      return
    }
    history.value = [
      {
        id: genId(),
        createdAt: now,
        prompt: entry.prompt,
        itinerary: entry.itinerary,
      },
      ...history.value,
    ].slice(0, HISTORY_LIMIT)
  }

  /** 切换到某条历史行程 */
  function switchToHistory(id: string) {
    const found = history.value.find((h) => h.id === id)
    if (!found) return false
    itinerary.value = found.itinerary
    userPrompt.value = found.prompt
    hasGenerated.value = true
    // 切到完全不同的行程后，旧的撤销栈对不上号，直接清空
    clearUndoRedo()
    return true
  }

  function removeHistory(id: string) {
    history.value = history.value.filter((h) => h.id !== id)
  }

  function clearHistory() {
    history.value = []
  }

  /** 取消当前正在跑的请求（如果有） */
  function cancelActiveRequest(): boolean {
    if (!activeController) return false
    activeController.abort()
    activeController = null
    return true
  }

  /**
   * 调用大模型生成行程。失败时**抛出异常**给上层（组件用 ElMessage 弹窗）。
   * 成功后写入 store + 历史记录，自动驱动 Timeline 刷新。
   *
   * 注意：整段重新生成会清空撤销栈，因为旧的微调快照
   * 已经和新行程对不上了，留着只会引发误解。
   */
  async function generate() {
    const prompt = userPrompt.value.trim()
    if (!prompt) {
      throw new Error('请输入你的旅行需求')
    }
    // 取消上一个进行中的请求（如果有）
    cancelActiveRequest()
    const controller = new AbortController()
    activeController = controller
    isGenerating.value = true
    try {
      const next = await generateItinerary({
        userPrompt: prompt,
        signal: controller.signal,
      })
      itinerary.value = next
      hasGenerated.value = true
      clearUndoRedo()
      pushHistory({ prompt, itinerary: next })
      return next
    } finally {
      isGenerating.value = false
      if (activeController === controller) {
        activeController = null
      }
    }
  }

  /**
   * 给定 ModifyScope，计算"在 LLM 跑的时候要给哪些卡片打 loading 遮罩"。
   * - single   ：单个目标节点
   * - multiple ：用户勾选的所有节点
   * - day      ：该天的所有节点（可能整天会被改）
   * - whole    ：所有天的所有节点
   */
  function keysFromScope(snap: Itinerary, scope: ModifyScope): Set<ModifyKey> {
    const keys = new Set<ModifyKey>()
    if (scope.kind === 'single') {
      keys.add(makeModifyKey(scope.dayIndex, scope.activityIndex))
    } else if (scope.kind === 'multiple') {
      for (const t of scope.targets) {
        keys.add(makeModifyKey(t.dayIndex, t.activityIndex))
      }
    } else if (scope.kind === 'day') {
      const day = snap.days[scope.dayIndex]
      if (day) {
        day.activities.forEach((_, idx) => {
          keys.add(makeModifyKey(scope.dayIndex, idx))
        })
      }
    } else {
      // whole
      snap.days.forEach((day, dIdx) => {
        day.activities.forEach((_, aIdx) => {
          keys.add(makeModifyKey(dIdx, aIdx))
        })
      })
    }
    return keys
  }

  /**
   * 按 scope 调用大模型修改行程：
   * - 把"完整行程 + 修改范围描述 + 用户诉求"一起塞给模型
   * - 拿回完整的更新行程后通过 commitChange 写入（自动入 undoStack）
   *
   * 期间 modifyingKeys 标记当前正在改的节点集合，UI 据此加 loading 遮罩。
   * 任意子 scope 失败时不污染撤销栈、不更新 itinerary，让用户可以重试。
   */
  async function modifyByScope(scope: ModifyScope, instruction: string) {
    const trimmed = instruction.trim()
    if (!trimmed) {
      throw new Error('请描述一下你想怎么修改')
    }
    if (isModifying.value) {
      throw new Error('正在处理上一个修改请求，请稍候')
    }
    cancelActiveRequest()
    const controller = new AbortController()
    activeController = controller
    const snapshot = itinerary.value
    const primaryKeys = keysFromScope(snapshot, scope)
    modifyingKeys.value = primaryKeys
    modifyingScopeKind.value = scope.kind
    // 旧的"AI 联动调整"高亮先清掉，避免和新一次修改的高亮叠加
    clearCascadeHighlight()
    try {
      const next = await modifyItinerary({
        currentItinerary: snapshot,
        scope,
        userInstruction: trimmed,
        signal: controller.signal,
      })
      // 拿到新行程才落地快照，避免请求失败时污染撤销栈
      commitChange(next)

      // ============ P3: 计算 AI 顺手联动改的节点 ============
      // commitChange 之后 itinerary.value 已经是最终落地的版本（可能被 correctActivityTypes 兜底过）
      const post = itinerary.value
      const allChanged = diffActivityKeys(snapshot, post)
      // primary = 用户主动指定的范围；cascade = 实际变化但不在 primary 内的节点
      const cascade = new Set<ModifyKey>()
      for (const k of allChanged) {
        if (!primaryKeys.has(k)) cascade.add(k)
      }
      // day / whole 场景下，primary 已经覆盖了可能变化的全部节点，cascade 必然为空
      cascadeKeys.value = cascade
      lastModifySummary.value = {
        primaryCount: primaryKeys.size,
        cascadeCount: cascade.size,
        scopeKind: scope.kind,
        at: Date.now(),
      }
      // 5~6 秒后自动清掉高亮，给"我看到 AI 顺手改了哪些"留够时间
      cascadeClearTimer = setTimeout(() => {
        cascadeClearTimer = null
        cascadeKeys.value = new Set()
        lastModifySummary.value = null
      }, CASCADE_HOLD_MS)

      return next
    } finally {
      modifyingKeys.value = new Set()
      modifyingScopeKind.value = null
      if (activeController === controller) {
        activeController = null
      }
    }
  }

  /**
   * 兼容旧调用：单节点修改的便捷入口。内部直接走 modifyByScope。
   * 现有 hover 单卡片"修改"按钮的入口仍然用这个函数。
   */
  async function modifyActivity(
    dayIndex: number,
    activityIndex: number,
    instruction: string,
  ) {
    return modifyByScope({ kind: 'single', dayIndex, activityIndex }, instruction)
  }

  // ==================== P4: 探索面板状态 ====================

  /**
   * 探索面板默认每页 POI 数。高德 v2 PlaceSearch 单页上限 25，
   * 取 15 留点余量；翻页时不会因为页大小溢出失败。
   */
  const EXPLORE_PAGE_SIZE = 15

  const explorePanelOpen = ref<boolean>(false)
  /** 当前查的城市，默认从 itinerary 推断；用户可手动改 */
  const exploreCity = ref<string>('')
  /**
   * 关键词搜索词。
   * - 空：按 city + category 浏览（旧逻辑）
   * - 非空：把 keyword 作为关键词跨城搜（如"华东师范大学"），不再受 category 约束。
   * 该字段独立于 city，用户可同时在搜索框输入精准地点 + 让默认城市作为 hint。
   */
  const exploreKeyword = ref<string>('')
  const exploreCategory = ref<ExploreCategory>('attraction')
  /** 数据源：高德 PlaceSearch（实时全量） / LLM 攻略推荐（少而精） */
  const exploreSource = ref<'amap' | 'ai'>('amap')
  const exploreItems = ref<ExplorePoi[]>([])
  const explorePage = ref<number>(1)
  /** 还有下一页（仅 amap source 有意义；ai 一次性返回） */
  const exploreHasMore = ref<boolean>(false)
  const exploreTotal = ref<number>(0)
  const exploreLoading = ref<boolean>(false)
  const exploreError = ref<string | null>(null)

  /**
   * 当前展示的 AI 结果是否来自缓存。
   * UI 据此在"换一批"按钮旁标注"已缓存（点击换一批重新调用）"，
   * 让用户清楚知道这一批是不是新花了 token 拿到的。
   */
  const exploreFromCache = ref<boolean>(false)

  /**
   * AI 推荐结果缓存。key 同时编码：
   *   - category（景点/美食/酒店）
   *   - city（去空格小写）
   *   - 当前行程已包含的地点名集合的指纹（排序+长度）
   *
   * **为什么把 existingNames 也算进去**：
   * 行程一旦改了（增加/删除/替换节点），上一次 AI 推荐里的"避开重复"语义就过期了——
   * 比如原本被排除的"故宫"现在已经不在行程里，应该重新出现在推荐里；
   * 反过来新加进去的节点也不该再被推荐。绑进 key 让"行程改动 → 推荐自动失效"。
   *
   * - **会话内有效**：用 Map 而不是 localStorage，避免长期囤过期推荐
   * - 命中后直接渲染 → 不调 LLM，省钱省等待时间
   * - 用户点"换一批"会显式 forceRefresh 跳过缓存，并写回新结果覆盖旧缓存
   *
   * **大小控制**：单次 ExploreSuggestion[] 大约 4~8KB，会话内即使切换 20 次城市
   * 也不过 100~200KB，所以暂时不主动清理；clearAiSuggestionCache 提供手动入口。
   */
  const aiSuggestionCache = new Map<string, ExploreSuggestion[]>()

  /**
   * 给 existingNames 列表生成一个稳定的、紧凑的指纹。
   * - 排序后 join，保证顺序无关
   * - 控制长度：>120 字时截断 + 加 length 标记，避免 key 过长拉低 Map 性能
   */
  function fingerprintNames(names: string[]): string {
    if (!names.length) return 'none'
    const sorted = names.slice().sort()
    const joined = sorted.join('|')
    if (joined.length <= 120) return `${sorted.length}:${joined}`
    // 长行程：取前 6 + 后 4 + 总数（碰撞极小，且不影响"行程一变就失效"的核心目标）
    const head = sorted.slice(0, 6).join('|')
    const tail = sorted.slice(-4).join('|')
    return `${sorted.length}:${head}|...|${tail}`
  }

  function aiCacheKey(
    city: string,
    cat: ExploreCategory,
    existingNames: string[] = [],
  ): string {
    return `${cat}::${city.trim().toLowerCase()}::${fingerprintNames(existingNames)}`
  }
  /**
   * 用户点击 POI 卡片"📍 看地图"后，地图组件可以 watch 这个 ref 做 pan/highlight。
   * 写入后短时间内 DayMap 会消化掉它。
   */
  const exploreFocusPoi = ref<{
    name: string
    address: string
    coords?: { lng: number; lat: number }
    at: number
  } | null>(null)
  /** 探索面板独立的 AbortController，与生成 / 修改互不干扰 */
  let exploreController: AbortController | null = null

  /** 收集当前行程里所有地点名（去重），让 AI 推荐时避开重复 */
  function collectExistingActivityNames(): string[] {
    const set = new Set<string>()
    for (const day of itinerary.value.days) {
      for (const act of day.activities) {
        const n = act.location?.trim()
        if (n) set.add(n)
      }
    }
    return Array.from(set)
  }

  /** 从当前 itinerary 推断默认城市（trip_title / summary / 第一个活动地址） */
  function inferDefaultExploreCity(): string {
    const trip = itinerary.value
    const fromTrip = inferCityFromText(trip.trip_title, trip.summary)
    if (fromTrip) return fromTrip
    for (const day of trip.days) {
      for (const act of day.activities) {
        const fromAct = inferCityFromText(act.address, act.location)
        if (fromAct) return fromAct
      }
    }
    return ''
  }

  function openExplorePanel() {
    if (!exploreCity.value.trim()) {
      exploreCity.value = inferDefaultExploreCity()
    }
    explorePanelOpen.value = true
    // 第一次打开 / 上次没结果时，自动拉一页让用户立刻看到内容
    if (!exploreItems.value.length && exploreCity.value.trim()) {
      void loadExplorePage(1)
    }
  }

  function closeExplorePanel() {
    explorePanelOpen.value = false
    // 取消可能正在飞的请求，避免面板关了之后还把 loading 置位
    if (exploreController) {
      exploreController.abort()
      exploreController = null
    }
    exploreLoading.value = false
  }

  function toggleExplorePanel() {
    if (explorePanelOpen.value) closeExplorePanel()
    else openExplorePanel()
  }

  /** 切换分类：清空当前列表 + 重新拉第一页 */
  function setExploreCategory(cat: ExploreCategory) {
    if (exploreCategory.value === cat) return
    exploreCategory.value = cat
    exploreItems.value = []
    explorePage.value = 1
    exploreError.value = null
    if (exploreCity.value.trim()) void loadExplorePage(1)
  }

  /** 切换数据源（高德 / AI 推荐） */
  function setExploreSource(src: 'amap' | 'ai') {
    if (exploreSource.value === src) return
    exploreSource.value = src
    exploreItems.value = []
    explorePage.value = 1
    exploreError.value = null
    if (exploreCity.value.trim()) void loadExplorePage(1)
  }

  /** 切换城市：用户在输入框确认后触发 */
  async function setExploreCity(city: string) {
    const trimmed = city.trim()
    if (exploreCity.value === trimmed) return
    exploreCity.value = trimmed
    exploreItems.value = []
    explorePage.value = 1
    exploreError.value = null
    if (trimmed) await loadExplorePage(1)
  }

  /**
   * 设置关键词并立即搜索。
   * - 关键词非空 → 走"关键词搜索"分支（跨城、不限分类）
   * - 关键词置空 → 自动回到"按 city + category 浏览"
   *
   * 数据源固定走 amap：AI 推荐对精准 POI 名（如"华东师范大学"）效果不如高德。
   */
  async function setExploreKeyword(keyword: string) {
    const trimmed = keyword.trim()
    if (exploreKeyword.value === trimmed) return
    exploreKeyword.value = trimmed
    exploreItems.value = []
    explorePage.value = 1
    exploreError.value = null
    if (trimmed) {
      // 关键词搜索强制 amap，避免用户在 AI 模式下输入精准 POI 名却拿不到结果
      if (exploreSource.value !== 'amap') exploreSource.value = 'amap'
      await loadExplorePage(1)
    } else if (exploreCity.value.trim()) {
      await loadExplorePage(1)
    }
  }

  /** 清除当前关键词，回到"按城市 + 分类"浏览 */
  async function clearExploreKeyword() {
    if (!exploreKeyword.value) return
    await setExploreKeyword('')
  }

  /**
   * 把 ExploreSuggestion 转成 ExplorePoi（带新生成的 id）。
   * 抽出来是因为缓存命中和新拿到结果两条路径都要走相同映射。
   */
  function mapAiSuggestionsToPois(
    items: ExploreSuggestion[],
    cat: ExploreCategory,
  ): ExplorePoi[] {
    return items.map((s, i) => ({
      id: `ai-${cat}-${Date.now()}-${i}`,
      name: s.name,
      address: s.address,
      category: s.category,
      source: 'ai',
      duration_minutes: s.duration_minutes,
      cost_estimate: s.cost_estimate,
      description: s.description,
      tips: s.tips,
    }))
  }

  /**
   * 加载指定页的 POI（amap 翻页 / ai 一次性）。
   * 触发 exploreLoading；同一时刻只允许一个请求，靠 AbortController 互斥。
   *
   * @param page  页码（仅 amap 用）
   * @param opts.forceRefresh  ai 数据源时跳过缓存，强制再调 LLM（"换一批"会用）
   */
  async function loadExplorePage(
    page: number,
    opts: { forceRefresh?: boolean } = {},
  ) {
    const city = exploreCity.value.trim()
    const keyword = exploreKeyword.value.trim()
    // 关键词模式 city 可空（用户可能直接搜"上海迪士尼乐园"）；
    // 浏览模式必须有 city，否则报错引导用户输入
    if (!keyword && !city) {
      exploreError.value = '请先在上方输入城市或地点关键词'
      return
    }
    if (exploreLoading.value) return
    if (exploreController) {
      exploreController.abort()
    }
    const controller = new AbortController()
    exploreController = controller
    exploreError.value = null

    // ============ AI 数据源 + 缓存命中：直接渲染，不开 loading 也不调 LLM ============
    // existingNames 进 key —— 行程一改，上次推荐就该失效，不再误命中
    // 关键词搜索不走 AI（AI 对精准 POI 名效果差），所以这段只在 keyword 为空时跑
    const namesForCache =
      !keyword && exploreSource.value === 'ai' ? collectExistingActivityNames() : []
    if (!keyword && exploreSource.value === 'ai' && !opts.forceRefresh) {
      const cached = aiSuggestionCache.get(
        aiCacheKey(city, exploreCategory.value, namesForCache),
      )
      if (cached?.length) {
        exploreItems.value = mapAiSuggestionsToPois(cached, exploreCategory.value)
        explorePage.value = 1
        exploreTotal.value = cached.length
        exploreHasMore.value = false
        exploreFromCache.value = true
        if (exploreController === controller) exploreController = null
        return
      }
    }

    exploreLoading.value = true
    try {
      if (keyword) {
        // ============ 关键词搜索分支：跨城、不限 category ============
        const res = await searchAnyPois(keyword, {
          city,
          page,
          pageSize: EXPLORE_PAGE_SIZE,
        })
        if (controller.signal.aborted) return
        const mapped: ExplorePoi[] = res.items.map((p) => ({
          id: p.id,
          name: p.name,
          address: p.address,
          category: p.category,
          source: 'amap',
          coords: p.coords,
          cityname: p.cityname,
          typename: p.typename,
          district: p.district,
        }))
        exploreItems.value = mapped
        explorePage.value = page
        exploreTotal.value = res.total
        exploreHasMore.value = mapped.length >= EXPLORE_PAGE_SIZE
        exploreFromCache.value = false
        // 没结果时给一个友好的空态文案
        if (!mapped.length) {
          exploreError.value = `没找到与「${keyword}」匹配的地点，可换个关键词`
        }
      } else if (exploreSource.value === 'amap') {
        const res = await searchCityPois(
          exploreCategory.value,
          city,
          page,
          EXPLORE_PAGE_SIZE,
        )
        if (controller.signal.aborted) return
        const mapped: ExplorePoi[] = res.items.map((p) => ({
          id: p.id,
          name: p.name,
          address: p.address,
          category: p.category,
          source: 'amap',
          coords: p.coords,
          cityname: p.cityname,
          typename: p.typename,
          district: p.district,
        }))
        exploreItems.value = mapped
        explorePage.value = page
        exploreTotal.value = res.total
        exploreHasMore.value = mapped.length >= EXPLORE_PAGE_SIZE
        exploreFromCache.value = false
      } else {
        const items = await generateExploreSuggestions({
          city,
          category: exploreCategory.value,
          // 复用前面命中阶段已经算过的 names —— 避免行程在请求中途变了导致
          // 写缓存的 key 跟刚才命中查询的 key 不一致
          existingNames: namesForCache,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        aiSuggestionCache.set(
          aiCacheKey(city, exploreCategory.value, namesForCache),
          items,
        )
        exploreItems.value = mapAiSuggestionsToPois(items, exploreCategory.value)
        explorePage.value = 1
        exploreTotal.value = items.length
        exploreHasMore.value = false
        exploreFromCache.value = false
      }
    } catch (err) {
      if (controller.signal.aborted) return
      exploreError.value = err instanceof Error ? err.message : '加载失败'
    } finally {
      if (exploreController === controller) {
        exploreController = null
      }
      if (!controller.signal.aborted) {
        exploreLoading.value = false
      }
    }
  }

  function nextExplorePage() {
    if (!exploreHasMore.value || exploreLoading.value) return
    return loadExplorePage(explorePage.value + 1)
  }

  function prevExplorePage() {
    if (explorePage.value <= 1 || exploreLoading.value) return
    return loadExplorePage(explorePage.value - 1)
  }

  /** AI 数据源专用："换一批"按钮：强制绕过缓存，再花一次钱调 LLM */
  function refreshExploreFromAi() {
    if (exploreSource.value !== 'ai') return
    return loadExplorePage(1, { forceRefresh: true })
  }

  /**
   * 主动清空 AI 推荐缓存。
   * 暂时没有 UI 入口，留给开发调试和未来"清空设置"使用。
   */
  function clearAiSuggestionCache() {
    aiSuggestionCache.clear()
    exploreFromCache.value = false
  }

  /**
   * 把一个 POI 标为"地图聚焦"，让 DayMap 组件 watch 这个 ref 后做 pan + 临时 marker。
   * 写入时间戳是为了：即便用户连续两次点同一个 POI 也能触发新的 watch。
   */
  function focusPoiOnMap(poi: ExplorePoi) {
    exploreFocusPoi.value = {
      name: poi.name,
      address: poi.address,
      coords: poi.coords,
      at: Date.now(),
    }
  }

  function clearExploreFocus() {
    exploreFocusPoi.value = null
  }

  // ==================== P4: 插入 / 替换 ====================

  /**
   * 把 ExplorePoi 转成 Activity，用于"插入 / 替换"。
   * - type 由 category 一一映射
   * - duration 优先用 POI 自带，否则按 category 默认（食 60 / 景 120 / 宿 720）
   * - time 由调用方决定（插入要根据邻居推；替换可以保留原 time）
   */
  function buildActivityFromExplorePoi(
    poi: ExplorePoi,
    overrides: Partial<Pick<Activity, 'time' | 'duration_minutes'>> = {},
  ): Activity {
    const type: ActivityType =
      poi.category === 'attraction'
        ? 'attraction'
        : poi.category === 'food'
        ? 'food'
        : 'hotel'
    const defaultDuration =
      poi.duration_minutes ??
      (poi.category === 'food' ? 60 : poi.category === 'attraction' ? 120 : 720)
    const labelByCategory =
      poi.category === 'attraction' ? '景点' : poi.category === 'food' ? '餐饮' : '住宿'
    return {
      time: overrides.time ?? '12:00',
      type,
      location: poi.name,
      address: poi.address,
      duration_minutes: overrides.duration_minutes ?? defaultDuration,
      description: poi.description ?? `从探索面板添加的${labelByCategory}`,
      cost_estimate: poi.cost_estimate ?? 0,
      tips: poi.tips ?? '',
    }
  }

  /**
   * 给定上一节点的 time + duration，推一个"看起来还算合理"的下一节点开始时间。
   * 简单做法：上一活动结束 + 30 分钟缓冲。如果上一节点没有 time / duration，
   * 直接返回 undefined，让 buildActivityFromExplorePoi 用默认 12:00。
   */
  function inferNextStartTime(prev?: Activity): string | undefined {
    if (!prev?.time) return undefined
    const m = /^(\d{1,2}):(\d{2})$/.exec(prev.time.trim())
    if (!m) return undefined
    const h = Number(m[1])
    const mm = Number(m[2])
    if (Number.isNaN(h) || Number.isNaN(mm)) return undefined
    const dur = prev.duration_minutes ?? 60
    const total = h * 60 + mm + dur + 30
    const newH = Math.floor(total / 60) % 24
    const newM = total % 60
    return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
  }

  /**
   * 在指定位置插入一个活动。position = 0..day.activities.length（0 头部，N 尾部）
   * 插入新节点的 time 会基于"position-1"那个邻居推一下，避免一上来就和前一个时间撞了。
   * 走 commitChange，可被 ⌘Z 撤销。
   */
  function insertActivity(
    dayIndex: number,
    position: number,
    activity: Activity,
  ): boolean {
    const trip = itinerary.value
    if (dayIndex < 0 || dayIndex >= trip.days.length) return false
    const day = trip.days[dayIndex]
    const clamped = Math.max(0, Math.min(position, day.activities.length))
    const prev = clamped > 0 ? day.activities[clamped - 1] : undefined
    const inferred = inferNextStartTime(prev)
    const finalActivity: Activity =
      // 调用方已显式给了 time 就尊重它；否则用推算时间兜底
      activity.time && activity.time !== '12:00'
        ? activity
        : { ...activity, time: inferred ?? activity.time }
    const newActivities = [
      ...day.activities.slice(0, clamped),
      finalActivity,
      ...day.activities.slice(clamped),
    ]
    const newDays = trip.days.map((d, i) =>
      i === dayIndex ? { ...d, activities: newActivities } : d,
    )
    commitChange({ ...trip, days: newDays })
    return true
  }

  /**
   * 替换指定位置的活动。**保留原节点的 time**（除非新节点显式自带），
   * 这样替换一个 POI 不会破坏整天的时间安排。
   */
  function replaceActivity(
    dayIndex: number,
    activityIndex: number,
    activity: Activity,
  ): boolean {
    const trip = itinerary.value
    if (dayIndex < 0 || dayIndex >= trip.days.length) return false
    const day = trip.days[dayIndex]
    if (activityIndex < 0 || activityIndex >= day.activities.length) return false
    const old = day.activities[activityIndex]
    const merged: Activity = {
      ...activity,
      // 替换时优先沿用原 time + duration，不破坏整天编排
      time: activity.time && activity.time !== '12:00' ? activity.time : old.time,
      duration_minutes: activity.duration_minutes ?? old.duration_minutes,
    }
    const newActivities = day.activities.map((a, i) => (i === activityIndex ? merged : a))
    const newDays = trip.days.map((d, i) =>
      i === dayIndex ? { ...d, activities: newActivities } : d,
    )
    commitChange({ ...trip, days: newDays })
    return true
  }

  /** ExplorePoi 直接插入：负责把 POI → Activity 的转换 + 调 insertActivity */
  function insertExplorePoi(
    poi: ExplorePoi,
    dayIndex: number,
    position: number,
  ): boolean {
    const activity = buildActivityFromExplorePoi(poi)
    return insertActivity(dayIndex, position, activity)
  }

  /** ExplorePoi 直接替换 */
  function replaceWithExplorePoi(
    poi: ExplorePoi,
    dayIndex: number,
    activityIndex: number,
  ): boolean {
    const activity = buildActivityFromExplorePoi(poi)
    return replaceActivity(dayIndex, activityIndex, activity)
  }

  /**
   * 内部辅助：在内存里计算出"插入新节点"后的 itinerary，但**不 commit**。
   * 抽出来是为了让 cascadeTimes 路径能拿着这份"假插入"的 itinerary
   * 直接喂给 LLM 调时间，最后**只走一次 commitChange**（保证单步 undo 友好）。
   */
  function computeInsertedItinerary(
    trip: Itinerary,
    dayIndex: number,
    position: number,
    activity: Activity,
  ): { next: Itinerary; insertedAt: number } | null {
    if (dayIndex < 0 || dayIndex >= trip.days.length) return null
    const day = trip.days[dayIndex]
    const clamped = Math.max(0, Math.min(position, day.activities.length))
    const prev = clamped > 0 ? day.activities[clamped - 1] : undefined
    const inferred = inferNextStartTime(prev)
    const finalActivity: Activity =
      activity.time && activity.time !== '12:00'
        ? activity
        : { ...activity, time: inferred ?? activity.time }
    const newActivities = [
      ...day.activities.slice(0, clamped),
      finalActivity,
      ...day.activities.slice(clamped),
    ]
    const newDays = trip.days.map((d, i) =>
      i === dayIndex ? { ...d, activities: newActivities } : d,
    )
    return { next: { ...trip, days: newDays }, insertedAt: clamped }
  }


  /**
   * 智能插入：先把节点写到内存里，再可选调 LLM "day" scope 只改 time/duration，
   * 最后**单次 commitChange** —— 用户按一次 ⌘Z 能完整撤销整个动作。
   *
   * 行为分支：
   * - `opts.cascadeTimes` = false → 与 insertExplorePoi 完全等价
   * - `opts.cascadeTimes` = true 且无并发任务 → 调 LLM 联动
   * - 已有 AI 任务在跑 / LLM 失败 / 用户取消 → 回退到"只插入"，并通过 fallbackReason 告知 UI
   */
  async function insertExplorePoiSmart(
    poi: ExplorePoi,
    dayIndex: number,
    position: number,
    opts: { cascadeTimes?: boolean } = {},
  ): Promise<InsertSmartResult> {
    const preTrip = itinerary.value
    const activity = buildActivityFromExplorePoi(poi)
    const computed = computeInsertedItinerary(preTrip, dayIndex, position, activity)
    if (!computed) {
      return { ok: false, cascaded: false, fallbackReason: '无效的插入位置' }
    }
    return commitDayMutationWithOptionalCascade({
      preTrip,
      postTrip: computed.next,
      dayIndex,
      primaryKey: makeModifyKey(dayIndex, computed.insertedAt),
      cascadeTimes: !!opts.cascadeTimes,
      userInstruction: [
        `我刚刚把【${poi.name}】插入到 Day ${dayIndex + 1} 的位置 ${computed.insertedAt + 1}（共 ${computed.next.days[dayIndex].activities.length} 项）。`,
        '请**仅调整**这一天每个节点的 time 字段（必要时同步 duration_minutes），让整天节奏合理顺畅。',
        '**严禁**修改任何节点的 location / type / address / description / cost_estimate / tips。',
        '**严禁**增删任何节点；**严禁**改动其他天。',
        '如果当前时间编排已经合理，可以原样返回，不要为了改而改。',
      ].join('\n'),
    })
  }

  /**
   * 公共"日内修改 + 可选 LLM 时间联动 + 单次 commit"路径。
   *
   * insertExplorePoiSmart / replaceExplorePoiSmart 都靠这个工具拼出来：
   * 它们各自负责把 (preTrip → postTrip) 的差异在内存中算好，再喂给本函数。
   *
   * 流程：
   *   1. cascadeTimes=false → 直接 commitChange(postTrip)
   *   2. 已有 AI 任务在跑 → 兜底 commit + fallbackReason
   *   3. 调 LLM modifyItinerary({ kind: 'day' }) 只改 time/duration
   *   4. 成功 → commit(LLM 输出) + diff 出 cascade（除 primaryKey 之外的）
   *   5. 失败/取消 → commit(postTrip) + fallbackReason
   *
   * 始终只 commitChange 一次，保证一次 ⌘Z 能整段回滚。
   */
  async function commitDayMutationWithOptionalCascade(args: {
    preTrip: Itinerary
    postTrip: Itinerary
    dayIndex: number
    primaryKey: ModifyKey
    cascadeTimes: boolean
    userInstruction: string
  }): Promise<InsertSmartResult> {
    const { preTrip, postTrip, dayIndex, primaryKey, cascadeTimes, userInstruction } = args

    if (!cascadeTimes) {
      commitChange(postTrip)
      return { ok: true, cascaded: false }
    }

    if (isModifying.value || isGenerating.value) {
      commitChange(postTrip)
      return {
        ok: true,
        cascaded: false,
        fallbackReason: '当前已有 AI 任务在跑，未联动调整时间',
      }
    }

    cancelActiveRequest()
    const controller = new AbortController()
    activeController = controller

    // 标记当天所有节点为 loading，UI 会给整天打遮罩
    const dayKeys = new Set<ModifyKey>()
    postTrip.days[dayIndex]?.activities.forEach((_, i) => {
      dayKeys.add(makeModifyKey(dayIndex, i))
    })
    modifyingKeys.value = dayKeys
    modifyingScopeKind.value = 'day'
    clearCascadeHighlight()

    try {
      const next = await modifyItinerary({
        currentItinerary: postTrip,
        scope: { kind: 'day', dayIndex },
        userInstruction,
        signal: controller.signal,
      })
      commitChange(next)

      // diff 是相对"修改前"的版本：被 LLM 改动的所有节点
      // 去掉 primaryKey（本次"主操作"对应的节点） = AI 顺手联动的
      const allChanged = diffActivityKeys(preTrip, next)
      const cascade = new Set<ModifyKey>()
      for (const k of allChanged) {
        if (k !== primaryKey) cascade.add(k)
      }
      cascadeKeys.value = cascade
      lastModifySummary.value = {
        primaryCount: 1,
        cascadeCount: cascade.size,
        scopeKind: 'single',
        at: Date.now(),
      }
      cascadeClearTimer = setTimeout(() => {
        cascadeClearTimer = null
        cascadeKeys.value = new Set()
        lastModifySummary.value = null
      }, CASCADE_HOLD_MS)

      return { ok: true, cascaded: true, cascadeCount: cascade.size }
    } catch (err) {
      if (controller.signal.aborted) {
        commitChange(postTrip)
        return { ok: true, cascaded: false, fallbackReason: '已取消时间联动' }
      }
      commitChange(postTrip)
      return {
        ok: true,
        cascaded: false,
        fallbackReason:
          err instanceof Error ? `时间联动失败：${err.message}` : '时间联动失败',
      }
    } finally {
      modifyingKeys.value = new Set()
      modifyingScopeKind.value = null
      if (activeController === controller) activeController = null
    }
  }

  /**
   * 内部辅助：在内存里计算出"替换某节点"后的 itinerary，但不 commit。
   * 与 replaceActivity 同样保留时间策略（沿用原节点 time / duration_minutes）。
   */
  function computeReplacedItinerary(
    trip: Itinerary,
    dayIndex: number,
    activityIndex: number,
    newActivity: Activity,
  ): { next: Itinerary; replaced: Activity } | null {
    if (dayIndex < 0 || dayIndex >= trip.days.length) return null
    const day = trip.days[dayIndex]
    if (activityIndex < 0 || activityIndex >= day.activities.length) return null
    const old = day.activities[activityIndex]
    const merged: Activity = {
      ...newActivity,
      time:
        newActivity.time && newActivity.time !== '12:00'
          ? newActivity.time
          : old.time,
      duration_minutes: newActivity.duration_minutes ?? old.duration_minutes,
    }
    const newActivities = day.activities.map((a, i) =>
      i === activityIndex ? merged : a,
    )
    const newDays = trip.days.map((d, i) =>
      i === dayIndex ? { ...d, activities: newActivities } : d,
    )
    return { next: { ...trip, days: newDays }, replaced: old }
  }

  /**
   * 智能替换：和 insertExplorePoiSmart 镜像。把节点替换后可选让 AI 调整这一天的时间，
   * 一次 commitChange，按 ⌘Z 整体回滚。
   *
   * 之所以替换也要联动：用户可能把"故宫(2h)"替换成"颐和园(3h)"，
   * 邻居的开始时间需要往后挪才合理；不联动会让整天的时间安排崩。
   */
  async function replaceExplorePoiSmart(
    poi: ExplorePoi,
    dayIndex: number,
    activityIndex: number,
    opts: { cascadeTimes?: boolean } = {},
  ): Promise<InsertSmartResult> {
    const preTrip = itinerary.value
    const newActivity = buildActivityFromExplorePoi(poi)
    const computed = computeReplacedItinerary(
      preTrip,
      dayIndex,
      activityIndex,
      newActivity,
    )
    if (!computed) {
      return { ok: false, cascaded: false, fallbackReason: '无效的替换位置' }
    }

    const replacedActivity = computed.next.days[dayIndex].activities[activityIndex]
    return commitDayMutationWithOptionalCascade({
      preTrip,
      postTrip: computed.next,
      dayIndex,
      primaryKey: makeModifyKey(dayIndex, activityIndex),
      cascadeTimes: !!opts.cascadeTimes,
      userInstruction: [
        `我刚刚把 Day ${dayIndex + 1} 第 ${activityIndex + 1} 项【${computed.replaced.location}】替换成了【${poi.name}】（建议时长 ${replacedActivity.duration_minutes ?? '未指定'} 分钟）。`,
        '请**仅调整**这一天每个节点的 time 字段（必要时同步 duration_minutes），让整天节奏合理：',
        '- 若新节点比原节点更花时间，把后续节点往后挪；',
        '- 若新节点更短，可以适当让后续节点提前，但不要不合理早于上午 8 点或晚于晚上 11 点；',
        '- 已被替换的节点本身的 time 也可调；',
        '**严禁**改动这一天**任何节点**的 location / type / address / description / cost_estimate / tips。',
        '**严禁**增删任何节点；**严禁**改动其他天。',
      ].join('\n'),
    })
  }

  /** 仅供调试 / 用户主动重置：清掉所有持久化数据 */
  function purgeStorage() {
    removeStorage(KEY_ITINERARY)
    removeStorage(KEY_PROMPT)
    removeStorage(KEY_HISTORY)
    removeStorage(KEY_HAS_GENERATED)
    removeStorage(KEY_CHOSEN_MODES)
    removeStorage(KEY_UNDO_STACK)
    removeStorage(KEY_REDO_STACK)
  }

  /** 判断给定节点是否是 AI 顺手联动改的（用 P3 浮标） */
  function isActivityCascade(dayIndex: number, activityIndex: number): boolean {
    return cascadeKeys.value.has(makeModifyKey(dayIndex, activityIndex))
  }

  return {
    itinerary,
    userPrompt,
    isGenerating,
    modifyingKeys,
    modifyingScopeKind,
    cascadeKeys,
    lastModifySummary,
    isModifying,
    isBusy,
    canUndo,
    canRedo,
    undoStack,
    redoStack,
    history,
    hasGenerated,
    geocodeRevision,
    routeRevision,
    isGeocodingBatch,
    geocodingProgress,
    chosenModes,
    totalDurationMinutes,
    transitCostEstimate,
    getChosenMode,
    setChosenMode,
    recommendModeByKm,
    setItinerary,
    commitChange,
    resetItinerary,
    isActivityModifying,
    isActivityCascade,
    clearCascadeHighlight,
    generate,
    modifyActivity,
    modifyByScope,
    undo,
    redo,
    cancelActiveRequest,
    switchToHistory,
    removeHistory,
    clearHistory,
    purgeStorage,
    triggerGeocodeForCurrent,
    bumpRouteRevision,
    retryFailedGeocodes,
    // ===== P4: 探索面板 =====
    explorePanelOpen,
    exploreCity,
    exploreKeyword,
    exploreCategory,
    exploreSource,
    exploreItems,
    explorePage,
    exploreHasMore,
    exploreTotal,
    exploreLoading,
    exploreError,
    exploreFocusPoi,
    exploreFromCache,
    openExplorePanel,
    closeExplorePanel,
    toggleExplorePanel,
    setExploreCategory,
    setExploreSource,
    setExploreCity,
    setExploreKeyword,
    clearExploreKeyword,
    loadExplorePage,
    nextExplorePage,
    prevExplorePage,
    refreshExploreFromAi,
    clearAiSuggestionCache,
    focusPoiOnMap,
    clearExploreFocus,
    insertExplorePoi,
    insertExplorePoiSmart,
    replaceWithExplorePoi,
    replaceExplorePoiSmart,
    insertActivity,
    replaceActivity,
  }
})

/**
 * 智能插入（cascadeTimes）的结果摘要，让 UI 据此分发 toast 文案。
 */
export interface InsertSmartResult {
  ok: boolean
  /** 是否真的联动调了时间（用户开了开关、且 LLM 跑成功了） */
  cascaded: boolean
  /** 实际被改的"非新插入"节点数；UI 文案"AI 顺手调整 N 项"用 */
  cascadeCount?: number
  /** 用户取消 / LLM 失败 / 并发冲突时的提示文案，UI 转成 warning toast */
  fallbackReason?: string
}

// 把 ModifyScope 类型也 re-export 一下，方便组件不用直接去 llmService 引
export type { ModifyScope }

// 把 GeocodeResult 类型也再 re-export 一下，方便组件不用直接去 amapService 引
export type { GeocodeResult }

// 探索面板用到的 ExploreCategory 也透出，组件不用直接 import llmService
export type { ExploreCategory }
