<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { Component } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Position,
  ForkSpoon,
  Promotion,
  House,
  MagicStick,
  Wallet,
  Loading,
  Download,
  Edit,
  RefreshLeft,
  RefreshRight,
  Clock,
  Delete,
  CircleClose,
  LocationInformation,
  Timer,
  MapLocation,
  Link,
} from '@element-plus/icons-vue'
import html2canvas from 'html2canvas'
import { saveAs } from 'file-saver'
import {
  useItineraryStore,
  makeModifyKey,
  type Activity,
  type ActivityType,
  type ExplorePoi,
  type HistoryEntry,
  type ModifyKey,
  type ModifyScope,
} from './store/useItineraryStore'
import { LlmServiceError } from './api/llmService'
import { hasAMapKey } from './utils/amapLoader'
import DayMap from './components/DayMap.vue'
import RouteSegment from './components/RouteSegment.vue'
import ExplorePanel from './components/ExplorePanel.vue'

const store = useItineraryStore()
const {
  itinerary,
  userPrompt,
  isGenerating,
  isModifying,
  isBusy,
  canUndo,
  canRedo,
  lastModifySummary,
  history,
  hasGenerated,
  transitCostEstimate,
  totalDurationMinutes,
  explorePanelOpen,
} = storeToRefs(store)

// 加载期间轮播的氛围文案，每 2 秒切一条，让等待不那么"无声"
// glm-5.1 默认开启「联网搜索 + 深度思考」，文案侧重凸显这点，
// 让用户理解"等的是有数据查证的真实方案，不是凭空生成"
const loadingPhrases = [
  '联网查阅最新景点信息',
  '核对餐厅真实地址与营业时间',
  '深度推理最佳游玩节奏',
  '锁定每个节点的精确位置',
  '按真实游玩时长安排时段',
  '估算门票与人均消费',
  '挑最合理的路线衔接方式',
  '汇总当地老司机的避坑建议',
]
const phraseIndex = ref(0)
const currentPhrase = computed(() => loadingPhrases[phraseIndex.value])
let phraseTimer: ReturnType<typeof setInterval> | null = null

/** 当次生成已等待的秒数，用于安抚长等待焦虑 */
const elapsedSeconds = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

/** 等待提示：随时间变化，越等越鼓励 */
// 联网搜索 + 深度思考的模式下耗时比纯生成更长（多步检索 + reasoning），
// 所以阈值整体上调一档；超过 3 分钟才考虑超时重试
const elapsedHint = computed(() => {
  const s = elapsedSeconds.value
  if (s < 45) return '联网检索景点 + 票价信息中…通常 45~120 秒'
  if (s < 90) return '正在比对多家口碑数据，请稍候'
  if (s < 150) return '描述较细，AI 正在认真打磨细节'
  return '网络可能稍慢，超时会自动重试一次'
})

function clearPhraseTimer() {
  if (phraseTimer !== null) {
    clearInterval(phraseTimer)
    phraseTimer = null
  }
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

watch(isGenerating, (loading) => {
  clearPhraseTimer()
  if (loading) {
    phraseIndex.value = 0
    elapsedSeconds.value = 0
    phraseTimer = setInterval(() => {
      phraseIndex.value = (phraseIndex.value + 1) % loadingPhrases.length
    }, 2000)
    elapsedTimer = setInterval(() => {
      elapsedSeconds.value += 1
    }, 1000)
  }
})

onUnmounted(clearPhraseTimer)

interface ActivityMeta {
  type: ActivityType
  label: string
  /** 柔和、低饱和度的主色，对应 CSS 中 --kind-* 变量；用于卡片 tag、地图 marker */
  color: string
  /** tag 背景色，比 color 更淡，做"色块 + 文本"的标签 */
  softColor: string
  /** 卡片内显示的小图标（element-plus icon 组件） */
  icon: Component
}

const activityMetaList: ActivityMeta[] = [
  {
    type: 'attraction',
    label: '景点',
    color: '#5d8a6b',
    softColor: '#e2ebdf',
    icon: markRaw(Position),
  },
  {
    type: 'food',
    label: '美食',
    color: '#c9874a',
    softColor: '#f5e4d0',
    icon: markRaw(ForkSpoon),
  },
  {
    type: 'transit',
    label: '交通',
    color: '#557087',
    softColor: '#dfe6ed',
    icon: markRaw(Promotion),
  },
  {
    type: 'hotel',
    label: '住宿',
    color: '#8a7aa6',
    softColor: '#e8e3f0',
    icon: markRaw(House),
  },
]

const activityMeta: Record<ActivityType, ActivityMeta> = activityMetaList.reduce(
  (acc, item) => {
    acc[item.type] = item
    return acc
  },
  {} as Record<ActivityType, ActivityMeta>,
)

/**
 * 图例展示项：去掉 transit。
 * 同城短途交通已被地图过渡段覆盖；偶尔出现的跨城长途 transit 节点
 * 在卡片里仍以蓝色呈现，但不在图例里展示，避免误导用户"系统缺哪个"。
 */
const legendList = activityMetaList.filter((m) => m.type !== 'transit')

function metaOf(type: ActivityType): ActivityMeta {
  return activityMeta[type]
}

function formatCost(value: number): string {
  if (value <= 0) return '免费'
  return `¥${value}`
}

/**
 * 把分钟数格式化成"约 1.5 小时 / 约 45 分钟"等中文。
 * <60min 用分钟；<60 整数小时直接 X 小时；其他 X.5 小时（半小时步进，避免 1.33 这种）。
 */
function formatDuration(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return ''
  if (minutes < 60) return `约 ${Math.round(minutes / 5) * 5} 分钟`
  const half = Math.round(minutes / 30) / 2
  if (Number.isInteger(half)) return `约 ${half} 小时`
  return `约 ${half} 小时`
}

/** 把累计分钟数格式化成 "X 天 X 小时" 或 "X 小时 X 分" */
function formatTotalDuration(minutes: number): string {
  if (!minutes) return ''
  const h = Math.round(minutes / 60)
  if (h < 24) return `${h} 小时`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`
}

const dailyTotals = computed(() =>
  itinerary.value.days.map((d) =>
    d.activities.reduce((sum: number, a: Activity) => sum + (a.cost_estimate || 0), 0),
  ),
)

/** 顶部 badge 用：天数 / 节点数 / 预估总价 */
const tripStats = computed(() => {
  const days = itinerary.value.days.length
  const activities = itinerary.value.days.reduce(
    (sum, d) => sum + d.activities.length,
    0,
  )
  return { days, activities, budget: itinerary.value.total_budget_estimate }
})

// ==================== 示例预设：降低空白页焦虑 ====================
interface PromptPreset {
  /** 城市名，作为视觉主标题（粗体） */
  city: string
  /** 风格副标，1~3 个字 */
  tag: string
  /** chip 上的小标签色（CSS 颜色字符串） */
  accent: string
  prompt: string
}

const promptPresets: PromptPreset[] = [
  {
    city: '北京',
    tag: '历史漫游',
    accent: '#c9874a',
    prompt:
      '5 月想去北京玩 2 天，喜欢历史和老北京小吃，预算 1500 以内，住前门附近。',
  },
  {
    city: '成都',
    tag: '吃辣看熊猫',
    accent: '#ec6f5a',
    prompt:
      '想去成都玩 3 天，喜欢吃辣和大熊猫，节奏不要太赶，预算 2000 以内，住春熙路附近。',
  },
  {
    city: '上海',
    tag: '亲子游',
    accent: '#8a7aa6',
    prompt:
      '带 6 岁小朋友去上海玩 3 天，想去迪士尼和外滩，预算 5000 左右，节奏放慢一点。',
  },
  {
    city: '厦门',
    tag: '海边慢旅',
    accent: '#557087',
    prompt:
      '5 月情侣去厦门 4 天，喜欢咖啡馆和海边日落，不爱排队，预算 4000 内。',
  },
]

function applyPreset(preset: PromptPreset) {
  if (isBusy.value) return
  userPrompt.value = preset.prompt
  ElMessage.success(`已为你填入：${preset.city} · ${preset.tag}`)
}

// ==================== 生成 / 取消 ====================

async function handleGenerate() {
  if (!userPrompt.value.trim()) {
    ElMessage.warning('请先描述你的旅行需求～')
    return
  }
  if (isModifying.value) {
    ElMessage.warning('正在为你微调节点，稍后再生成新行程')
    return
  }
  try {
    await store.generate()
    ElMessage.success('AI 已为你生成行程，可以在右侧查看')
  } catch (err) {
    console.error('[App] 行程生成失败：', err)
    if (err instanceof LlmServiceError) {
      // 用户主动取消：低调提示即可，不要显示「错误」
      if (err.code === 'ABORTED') {
        ElMessage.info('已取消本次生成')
        return
      }
      const duration = err.code === 'MISSING_API_KEY' ? 6000 : 4000
      ElMessage({
        type: 'error',
        message: err.message,
        duration,
        showClose: true,
      })
    } else if (err instanceof Error) {
      ElMessage.error(err.message)
    } else {
      ElMessage.error('生成失败，请稍后重试')
    }
  }
}

function handleCancelGenerate() {
  if (store.cancelActiveRequest()) {
    ElMessage.info('正在取消…')
  }
}

/**
 * 全量重置：清掉持久化的行程、输入、历史记录，回到空态。
 * 破坏性操作，需二次确认。
 */
async function handleReset() {
  if (isBusy.value) return
  try {
    await ElMessageBox.confirm(
      '会清空你当前的行程、输入和全部历史记录，无法恢复。要继续吗？',
      '清空数据',
      {
        confirmButtonText: '清空',
        cancelButtonText: '再想想',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }
  store.clearHistory()
  store.resetItinerary()
  store.purgeStorage()
  userPrompt.value = ''
  ElMessage.success('已清空所有数据')
}

// ==================== 快捷键：Cmd/Ctrl + Enter 提交 ====================
function handlePromptKeydown(event: KeyboardEvent) {
  // 仅在用户按下 modifier + Enter 时触发提交，单独 Enter 仍是换行
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    if (isGenerating.value) {
      handleCancelGenerate()
    } else {
      void handleGenerate()
    }
  }
}

// ==================== 历史记录 ====================
const historyVisible = ref(false)

function formatHistoryTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function pickHistory(item: HistoryEntry) {
  if (isBusy.value) return
  if (store.switchToHistory(item.id)) {
    historyVisible.value = false
    ElMessage.success(`已切换到：${item.itinerary.trip_title}`)
  }
}

async function deleteHistory(item: HistoryEntry, event: Event) {
  event.stopPropagation()
  try {
    await ElMessageBox.confirm(
      `确定删除「${item.itinerary.trip_title}」这条历史记录吗？`,
      '删除历史',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  store.removeHistory(item.id)
  ElMessage.success('已删除')
}

async function clearAllHistory() {
  try {
    await ElMessageBox.confirm('清空全部历史行程吗？此操作无法撤销。', '清空历史', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  store.clearHistory()
  ElMessage.success('已清空历史')
}

// ==================== 节点微调 (Modify) ====================
// 修改场景按 scope 分四种：
//   single   ：hover 单卡片"修改"按钮触发
//   multiple ：在选择模式下勾选若干节点后点"修改"
//   day      ：每天卡片头部"修改这一整天"按钮
//   whole    ：顶部工具栏"重排整个行程"按钮
// 全部走同一个 dialog，只是 header / quick prompts / 文案根据 scope 切换。

interface ModifyDialogState {
  visible: boolean
  scope: ModifyScope | null
  instruction: string
}

const modifyDialog = reactive<ModifyDialogState>({
  visible: false,
  scope: null,
  instruction: '',
})

/** 单节点场景：换一家更便宜 / 换更优 / 换步行可达等 */
const QUICK_PROMPTS_SINGLE = [
  '换一家更便宜的',
  '换一个评价更高的',
  '换成步行可达的',
  '把时间提前一小时',
  '换个更小众的',
] as const

/** 多节点场景：批量替换 / 节奏放松 / 整体便宜 */
const QUICK_PROMPTS_MULTIPLE = [
  '这几个换得便宜一些',
  '替换成更小众的',
  '换成更轻松的节奏',
  '把这些都改成步行可达的',
] as const

/** 整天场景：节奏放松 / 主题切换 / 删一项 */
const QUICK_PROMPTS_DAY = [
  '这天太满了，节奏放松一些',
  '换成亲子向',
  '换成美食优先的安排',
  '这天预算砍一半',
  '减少一项让节奏更慢',
] as const

/** 整体场景：天数 / 主题 / 总预算调整 */
const QUICK_PROMPTS_WHOLE = [
  '整体便宜一半',
  '改成 3 天紧凑版',
  '主题换成情侣慢游',
  '增加更多本地小众体验',
] as const

const modifyQuickPrompts = computed(() => {
  switch (modifyDialog.scope?.kind) {
    case 'multiple':
      return QUICK_PROMPTS_MULTIPLE
    case 'day':
      return QUICK_PROMPTS_DAY
    case 'whole':
      return QUICK_PROMPTS_WHOLE
    case 'single':
    default:
      return QUICK_PROMPTS_SINGLE
  }
})

/** dialog 标题（按 scope 变化，无 emoji，仅文字） */
const modifyDialogTitle = computed(() => {
  switch (modifyDialog.scope?.kind) {
    case 'multiple':
      return `一次微调 ${modifyDialog.scope.targets.length} 个节点`
    case 'day':
      return '重排这一天的行程'
    case 'whole':
      return '重排整个行程'
    case 'single':
    default:
      return '微调这个节点'
  }
})

/**
 * dialog 提示语：告诉 AI 这次能动多少东西。
 * single 沿用原文案；其他几种场景明确告诉用户"未列出的会保持原样"。
 */
const modifyDialogHint = computed(() => {
  switch (modifyDialog.scope?.kind) {
    case 'multiple':
      return 'AI 只会改你选中的这几个节点，其他节点保持不变。'
    case 'day':
      return 'AI 可以重排这一天的所有节点（增删/换顺序/换内容），其他天保持原样。'
    case 'whole':
      return 'AI 可以重排整个行程：天数、节点、预算都可调，trip_title 与你的核心诉求会尽量保留。'
    case 'single':
    default:
      return '说说你的想法，AI 会重新搜一次最合适的方案。'
  }
})

/**
 * dialog textarea 的 placeholder：每种 scope 用一个贴合场景的具体示例，
 * 让用户一看就知道"我能在这儿写啥"。
 *   - single   ：换一家更便宜的餐厅 / 步行 10 分钟内能到 等"换一项"风格
 *   - multiple ：批量替换 / 让这几个都步行可达 等"针对几项"风格
 *   - day      ：节奏放松 / 主题切换 / 减一项 等"针对一整天"风格
 *   - whole    ：天数调整 / 整体便宜 / 主题切换 等"针对整段行程"风格
 */
const modifyDialogPlaceholder = computed(() => {
  switch (modifyDialog.scope?.kind) {
    case 'multiple':
      return '例如：把这几个都换成评价更高的；或这几顿饭都换成步行 10 分钟内的；或整体便宜一些'
    case 'day':
      return '例如：这天太满了，节奏放松一些；或整天换成美食优先；或减少一项给晚上留点自由时间'
    case 'whole':
      return '例如：整体预算砍一半；或改成 3 天紧凑版；或主题换成情侣慢游、保留迪士尼那天'
    case 'single':
    default:
      return '例如：换一家更便宜的餐厅；或换成步行 10 分钟内能到的地方'
  }
})

/**
 * 把 ModifyScope 展开成 dialog 头部要展示的目标节点摘要列表。
 * single ：1 行
 * multiple：N 行
 * day    ：该天的所有节点
 * whole  ：每天选 1~2 项作代表展示
 */
interface ScopeSummaryItem {
  dayIndex: number
  activityIndex: number
  activity: Activity
}

const modifyDialogTargets = computed<ScopeSummaryItem[]>(() => {
  const scope = modifyDialog.scope
  if (!scope) return []
  const trip = itinerary.value
  const collect = (dayIndex: number, activityIndex: number): ScopeSummaryItem | null => {
    const day = trip.days[dayIndex]
    if (!day) return null
    const act = day.activities[activityIndex]
    if (!act) return null
    return { dayIndex, activityIndex, activity: act }
  }
  if (scope.kind === 'single') {
    const it = collect(scope.dayIndex, scope.activityIndex)
    return it ? [it] : []
  }
  if (scope.kind === 'multiple') {
    return scope.targets
      .map((t) => collect(t.dayIndex, t.activityIndex))
      .filter((x): x is ScopeSummaryItem => x !== null)
  }
  if (scope.kind === 'day') {
    const day = trip.days[scope.dayIndex]
    if (!day) return []
    return day.activities.map((act, idx) => ({
      dayIndex: scope.dayIndex,
      activityIndex: idx,
      activity: act,
    }))
  }
  // whole：每天展示头/尾两个节点作代表
  const items: ScopeSummaryItem[] = []
  trip.days.forEach((day, dIdx) => {
    if (day.activities.length === 0) return
    const first = collect(dIdx, 0)
    if (first) items.push(first)
    if (day.activities.length > 1) {
      const last = collect(dIdx, day.activities.length - 1)
      if (last) items.push(last)
    }
  })
  return items
})

/**
 * 当前 dialog 是否正在被 LLM 处理（按 scope 判断 modifyingKeys 是否覆盖）。
 * 用来锁定 dialog 的「确认」按钮 + 关闭行为。
 */
const isCurrentScopeModifying = computed(() => {
  if (!modifyDialog.visible || !modifyDialog.scope) return false
  // 只要 scope 内有任意节点正在 loading，就视为本 dialog 正在处理
  for (const item of modifyDialogTargets.value) {
    if (store.isActivityModifying(item.dayIndex, item.activityIndex)) return true
  }
  return modifyDialog.scope.kind === 'whole' && isModifying.value
})

function openSingleModifyDialog(
  dayIndex: number,
  activityIndex: number,
  _activity: Activity,
) {
  modifyDialog.visible = true
  modifyDialog.scope = { kind: 'single', dayIndex, activityIndex }
  modifyDialog.instruction = ''
}

function openMultipleModifyDialog() {
  if (selectedKeys.value.size === 0) {
    ElMessage.warning('请先勾选要修改的节点')
    return
  }
  modifyDialog.visible = true
  modifyDialog.scope = { kind: 'multiple', targets: selectedTargets.value }
  modifyDialog.instruction = ''
}

function openDayModifyDialog(dayIndex: number) {
  modifyDialog.visible = true
  modifyDialog.scope = { kind: 'day', dayIndex }
  modifyDialog.instruction = ''
}

function openWholeModifyDialog() {
  modifyDialog.visible = true
  modifyDialog.scope = { kind: 'whole' }
  modifyDialog.instruction = ''
}

function appendQuickPrompt(text: string) {
  modifyDialog.instruction = modifyDialog.instruction
    ? `${modifyDialog.instruction}；${text}`
    : text
}

// ==================== 批量选择模式 ====================

const selectionMode = ref(false)
const selectedKeys = ref<Set<ModifyKey>>(new Set())

const selectedTargets = computed(() =>
  Array.from(selectedKeys.value).map((k) => {
    const [d, a] = k.split('-').map(Number)
    return { dayIndex: d, activityIndex: a }
  }),
)

function isActivitySelected(dayIndex: number, activityIndex: number): boolean {
  return selectedKeys.value.has(makeModifyKey(dayIndex, activityIndex))
}

function toggleActivitySelection(dayIndex: number, activityIndex: number) {
  const key = makeModifyKey(dayIndex, activityIndex)
  const next = new Set(selectedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}

function selectAllInDay(dayIndex: number) {
  const day = itinerary.value.days[dayIndex]
  if (!day) return
  const next = new Set(selectedKeys.value)
  day.activities.forEach((_, idx) => {
    next.add(makeModifyKey(dayIndex, idx))
  })
  selectedKeys.value = next
}

function clearSelection() {
  selectedKeys.value = new Set()
}

function enterSelectionMode() {
  selectionMode.value = true
  selectedKeys.value = new Set()
}

function exitSelectionMode() {
  selectionMode.value = false
  selectedKeys.value = new Set()
}

function toggleSelectionMode() {
  if (selectionMode.value) exitSelectionMode()
  else enterSelectionMode()
}

// ==================== P4: 探索面板插入 / 替换 ====================

/**
 * 插入对话框：用户从探索面板点了"➕ 插入"后，在这里选"插哪一天的哪个位置"。
 * - dayIndex 默认 0
 * - position：0 = 开头，N = N-1 个活动之后；day.activities.length = 末尾
 * - cascadeTimes 默认开：插入后让 AI 顺手把这一天的时间排顺（复用 P3 联动机制）
 * - submitting：联动调用 LLM 期间锁定 dialog（loading 状态），避免用户连点
 */
const exploreInsertDialog = reactive<{
  visible: boolean
  poi: ExplorePoi | null
  dayIndex: number
  position: number
  cascadeTimes: boolean
  submitting: boolean
}>({
  visible: false,
  poi: null,
  dayIndex: 0,
  position: 0,
  cascadeTimes: true,
  submitting: false,
})

/**
 * 替换对话框：选要被替换的目标活动。
 * 与插入对话框对称：cascadeTimes 默认开（让 AI 顺手把这一天的时间排顺），
 * submitting 期间锁定 dialog。
 */
const exploreReplaceDialog = reactive<{
  visible: boolean
  poi: ExplorePoi | null
  dayIndex: number
  activityIndex: number
  cascadeTimes: boolean
  submitting: boolean
}>({
  visible: false,
  poi: null,
  dayIndex: 0,
  activityIndex: 0,
  cascadeTimes: true,
  submitting: false,
})

/** 探索面板触发"插入"事件：打开 picker dialog 让用户选位置 */
function handleExploreInsert(poi: ExplorePoi) {
  if (!itinerary.value.days.length) {
    ElMessage.warning('当前还没有行程，无法插入')
    return
  }
  exploreInsertDialog.poi = poi
  // 默认插到第一天的末尾，最不容易和已有节点冲突
  exploreInsertDialog.dayIndex = 0
  exploreInsertDialog.position = itinerary.value.days[0].activities.length
  exploreInsertDialog.visible = true
}

/** 探索面板触发"替换"事件 */
function handleExploreReplace(poi: ExplorePoi) {
  // 优先选同 type 的第一个节点作为默认替换目标，更符合直觉
  const targetType =
    poi.category === 'attraction'
      ? 'attraction'
      : poi.category === 'food'
      ? 'food'
      : 'hotel'
  let foundDay = 0
  let foundAct = 0
  outer: for (let d = 0; d < itinerary.value.days.length; d++) {
    const acts = itinerary.value.days[d].activities
    for (let a = 0; a < acts.length; a++) {
      if (acts[a].type === targetType) {
        foundDay = d
        foundAct = a
        break outer
      }
    }
  }
  if (!itinerary.value.days[foundDay]?.activities.length) {
    ElMessage.warning('当前行程没有可替换的节点')
    return
  }
  exploreReplaceDialog.poi = poi
  exploreReplaceDialog.dayIndex = foundDay
  exploreReplaceDialog.activityIndex = foundAct
  exploreReplaceDialog.visible = true
}

/** 当 day 改变时，position 可能越界，自动钳到末尾 */
function onInsertDayChange(newDay: number) {
  const day = itinerary.value.days[newDay]
  if (!day) return
  if (exploreInsertDialog.position > day.activities.length) {
    exploreInsertDialog.position = day.activities.length
  }
}

function onReplaceDayChange(newDay: number) {
  const day = itinerary.value.days[newDay]
  if (!day) return
  if (exploreReplaceDialog.activityIndex >= day.activities.length) {
    exploreReplaceDialog.activityIndex = Math.max(0, day.activities.length - 1)
  }
}

async function confirmExploreInsert() {
  const { poi, dayIndex, position, cascadeTimes } = exploreInsertDialog
  if (!poi) return
  if (exploreInsertDialog.submitting) return
  exploreInsertDialog.submitting = true
  try {
    const result = await store.insertExplorePoiSmart(poi, dayIndex, position, {
      cascadeTimes,
    })
    if (!result.ok) {
      ElMessage.error(`插入失败：${result.fallbackReason ?? '未知错误'}`)
      return
    }
    // 关 dialog 在 toast 之前，让用户视觉上更连贯
    exploreInsertDialog.visible = false
    if (result.cascaded) {
      if (result.cascadeCount && result.cascadeCount > 0) {
        ElMessage.success(
          `已插入「${poi.name}」并联动调整 ${result.cascadeCount} 项时间（⌘Z 撤销）`,
        )
      } else {
        ElMessage.success(`已插入「${poi.name}」，AI 检查后无需调整其它时间（⌘Z 撤销）`)
      }
    } else if (result.fallbackReason) {
      ElMessage.warning(
        `已插入「${poi.name}」，但${result.fallbackReason}（⌘Z 撤销）`,
      )
    } else {
      ElMessage.success(`已把「${poi.name}」插入到 Day ${dayIndex + 1}（⌘Z 撤销）`)
    }
  } finally {
    exploreInsertDialog.submitting = false
  }
}

async function confirmExploreReplace() {
  const { poi, dayIndex, activityIndex, cascadeTimes } = exploreReplaceDialog
  if (!poi) return
  if (exploreReplaceDialog.submitting) return
  exploreReplaceDialog.submitting = true
  try {
    const result = await store.replaceExplorePoiSmart(
      poi,
      dayIndex,
      activityIndex,
      { cascadeTimes },
    )
    if (!result.ok) {
      ElMessage.error(`替换失败：${result.fallbackReason ?? '未知错误'}`)
      return
    }
    exploreReplaceDialog.visible = false
    if (result.cascaded) {
      if (result.cascadeCount && result.cascadeCount > 0) {
        ElMessage.success(
          `已用「${poi.name}」替换并联动调整 ${result.cascadeCount} 项时间（⌘Z 撤销）`,
        )
      } else {
        ElMessage.success(`已用「${poi.name}」替换，AI 检查后无需调整其它时间（⌘Z 撤销）`)
      }
    } else if (result.fallbackReason) {
      ElMessage.warning(
        `已用「${poi.name}」替换，但${result.fallbackReason}（⌘Z 撤销）`,
      )
    } else {
      ElMessage.success(`已用「${poi.name}」替换 Day ${dayIndex + 1} 该节点（⌘Z 撤销）`)
    }
  } finally {
    exploreReplaceDialog.submitting = false
  }
}

/** 给"插入位置"下拉用：根据 dayIndex 算出每个槽位的展示文案 */
function insertPositionOptions(dayIndex: number) {
  const day = itinerary.value.days[dayIndex]
  if (!day) return [{ label: '开头', value: 0 }]
  const opts: Array<{ label: string; value: number }> = [
    { label: '放在这一天最开头', value: 0 },
  ]
  day.activities.forEach((act, i) => {
    opts.push({
      label: `${act.time} ${act.location} 之后`,
      value: i + 1,
    })
  })
  return opts
}

function handleUndo() {
  if (isBusy.value) return
  if (!store.undo()) {
    ElMessage.warning('当前没有可以撤销的修改')
    return
  }
  ElMessage.success('已撤销一步修改')
}

function handleRedo() {
  if (isBusy.value) return
  if (!store.redo()) {
    ElMessage.warning('没有可以重做的修改')
    return
  }
  ElMessage.success('已重做一步修改')
}

/**
 * 全局快捷键：⌘Z 撤销，⌘⇧Z / ⌃Y 重做。
 * 在用户正在输入框 / textarea 内时跳过，避免抢占系统的「文本撤销」。
 */
function handleGlobalShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  if (target) {
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
  }
  const isMod = event.metaKey || event.ctrlKey
  if (!isMod) return
  if (event.key === 'z' || event.key === 'Z') {
    event.preventDefault()
    if (event.shiftKey) handleRedo()
    else handleUndo()
  } else if (event.key === 'y' || event.key === 'Y') {
    event.preventDefault()
    handleRedo()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalShortcut)
})
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalShortcut)
})

/**
 * 确认本次修改：根据 dialog 当前的 scope 走 modifyByScope。
 * - 关闭 dialog 后让 v-loading 遮罩落到具体卡片上
 * - 多节点 / 整天 / 整体三种场景成功后自动退出选择模式
 */
async function confirmModify() {
  const instruction = modifyDialog.instruction.trim()
  if (!instruction) {
    ElMessage.warning('请告诉 AI 你想怎么修改')
    return
  }
  const scope = modifyDialog.scope
  if (!scope) {
    ElMessage.warning('当前没有选中的修改目标')
    return
  }
  modifyDialog.visible = false
  const sendingHint = (() => {
    switch (scope.kind) {
      case 'multiple':
        return `已发送给 AI，正在调整选中的 ${scope.targets.length} 个节点…`
      case 'day':
        return '已发送给 AI，正在重排这一天…'
      case 'whole':
        return '已发送给 AI，正在重排整个行程…'
      case 'single':
      default:
        return '已发送给 AI，正在为你调整这个节点…'
    }
  })()
  ElMessage.info(sendingHint)
  try {
    await store.modifyByScope(scope, instruction)
    ElMessage.success('已为你更新行程')
    // 多选 / 整天 / 整体修改成功后自动退出选择模式，少一步操作
    if (scope.kind !== 'single') exitSelectionMode()
  } catch (err) {
    console.error('[App] 微调失败：', err)
    if (err instanceof LlmServiceError) {
      if (err.code === 'ABORTED') {
        ElMessage.info('已取消本次微调')
        return
      }
      ElMessage({
        type: 'error',
        message: err.message,
        duration: 5000,
        showClose: true,
      })
    } else if (err instanceof Error) {
      ElMessage.error(err.message)
    } else {
      ElMessage.error('微调失败，请重试')
    }
  }
}

// ==================== 地图联动 ====================
// 每天独立维护一个 hover 状态：dayIndex → 当前 hover 的 activity index
// 用 -1 表示无 hover
const dayHoverIndex = reactive<Record<number, number>>({})

function setDayHover(dayIndex: number, activityIndex: number) {
  dayHoverIndex[dayIndex] = activityIndex
}
function clearDayHover(dayIndex: number) {
  dayHoverIndex[dayIndex] = -1
}
function getDayHover(dayIndex: number): number {
  return dayHoverIndex[dayIndex] ?? -1
}

/** 地图 marker 被点击：滚动到对应卡片并短暂高亮 */
function onMapPickActivity(dayIndex: number, activityIndex: number) {
  const card = document.querySelector<HTMLElement>(
    `[data-act-key="${dayIndex}-${activityIndex}"]`,
  )
  if (!card) return
  card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card.classList.add('act-card--flash')
  setTimeout(() => card.classList.remove('act-card--flash'), 1500)
}

/** 聚合 marker 被点击：跳到主节点 + 提示这里还有哪些节点 */
function onMapPickCluster(dayIndex: number, primaryIndex: number, otherIndexes: number[]) {
  onMapPickActivity(dayIndex, primaryIndex)
  const day = itinerary.value.days[dayIndex]
  if (!day) return
  const others = otherIndexes
    .map((i) => day.activities[i])
    .filter(Boolean)
    .map((act) => `「${act.location}」(${act.time})`)
    .join('、')
  if (others) {
    ElMessage({
      message: `这个位置还有：${others}`,
      type: 'info',
      duration: 3500,
      showClose: true,
    })
  }
}

/** AMap key 是否配置好（决定是否渲染地图相关组件） */
const amapEnabled = computed(() => hasAMapKey())

// ==================== 长图导出 ====================

const isExporting = ref(false)

/**
 * yyyyMMdd_HHmmss 时间戳，用作文件名后缀
 */
function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Promise 化 canvas.toBlob，便于在 await 流程里用
 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('canvas 转 Blob 失败'))
      },
      'image/png',
      1,
    )
  })
}

/**
 * 截取 #export-timeline-zone 元素为高清 PNG 长图并下载。
 * - scale: 2 → 双倍像素，避免移动端/Retina 屏发糊
 * - useCORS → 允许跨域图片（如未来接 CDN 图）渲染到 canvas
 * - backgroundColor → 强制白底，避免某些环境下出现透明/黑底
 * - 通过 `data-html2canvas-ignore` 跳过工具栏按钮自身
 */
async function exportAsImage() {
  if (isGenerating.value) {
    ElMessage.warning('正在生成行程，稍后再导出哦～')
    return
  }
  isExporting.value = true
  try {
    // 等一帧，让按钮 loading 状态先渲染出来
    await nextTick()
    const target = document.getElementById('export-timeline-zone')
    if (!target) {
      throw new Error('未找到导出区域 #export-timeline-zone')
    }

    const canvas = await html2canvas(target, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      // 让滚动条 / window.scrollX 漂移不影响截图准确性
      scrollX: 0,
      scrollY: -window.scrollY,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: document.documentElement.clientHeight,
    })

    const blob = await canvasToBlob(canvas)
    const filename = `AI专属行程单_${formatTimestamp()}.png`
    saveAs(blob, filename)
    ElMessage.success(`已保存：${filename}`)
  } catch (err) {
    console.error('[App] 导出长图失败：', err)
    ElMessage.error(
      err instanceof Error ? `导出失败：${err.message}` : '导出失败，请重试',
    )
  } finally {
    isExporting.value = false
  }
}
</script>

<template>
  <div class="planner">
    <header class="planner__header">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true">
          <span class="brand__mark-dot" />
          <span class="brand__mark-dot brand__mark-dot--accent" />
        </span>
        <div class="brand__text">
          <h1>说走就走</h1>
          <p>让 AI 把你的下一趟旅行排得明明白白</p>
        </div>
      </div>
      <div class="brand__meta">
        <span class="stat-pill" :title="`${tripStats.days} 天 · ${tripStats.activities} 个节点`">
          <span class="stat-pill__item">
            <span class="stat-pill__label">天数</span>
            <span class="stat-pill__value">{{ tripStats.days }}</span>
          </span>
          <span class="stat-pill__divider" />
          <span class="stat-pill__item">
            <span class="stat-pill__label">节点</span>
            <span class="stat-pill__value">{{ tripStats.activities }}</span>
          </span>
          <span class="stat-pill__divider" />
          <span class="stat-pill__item">
            <span class="stat-pill__label">预算</span>
            <span class="stat-pill__value">¥{{ tripStats.budget }}</span>
          </span>
        </span>
        <!-- GitHub 仓库入口：图标按钮 + tooltip，新标签页打开 -->
        <a
          class="github-link"
          href="https://github.com/MarioHuang2003/ai-travel-planner"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="在 GitHub 上查看项目源码"
          title="在 GitHub 上查看项目源码"
        >
          <svg
            class="github-link__icon"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.11.78-.25.78-.55 0-.27-.01-.99-.01-1.94-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18.91-.25 1.89-.38 2.86-.38.97 0 1.95.13 2.86.38 2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.67.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"
            />
          </svg>
          <span class="github-link__label">GitHub</span>
        </a>
        <el-popover
          v-model:visible="historyVisible"
          placement="bottom-end"
          :width="340"
          trigger="click"
          popper-class="history-popper"
        >
          <template #reference>
            <button
              type="button"
              class="history-trigger"
              :aria-label="`历史行程，共 ${history.length} 条`"
              :title="history.length ? '查看历史行程' : '还没有历史记录'"
            >
              <el-icon><Clock /></el-icon>
              <span>历史</span>
              <span v-if="history.length" class="history-trigger__count">
                {{ history.length }}
              </span>
            </button>
          </template>

          <div class="history-popover">
            <div class="history-popover__header">
              <strong>历史行程</strong>
              <button
                v-if="history.length"
                type="button"
                class="history-popover__clear"
                :disabled="isBusy"
                @click="clearAllHistory"
              >
                清空
              </button>
            </div>
            <p v-if="!history.length" class="history-popover__empty">
              还没有生成过行程<br />
              <span class="history-popover__empty-hint">
                生成成功后会自动保存最近 10 条
              </span>
            </p>
            <ul v-else class="history-list">
              <li
                v-for="item in history"
                :key="item.id"
                class="history-list__item"
                :class="{ 'is-disabled': isBusy }"
                :tabindex="isBusy ? -1 : 0"
                role="button"
                @click="pickHistory(item)"
                @keydown.enter.prevent="pickHistory(item)"
                @keydown.space.prevent="pickHistory(item)"
              >
                <div class="history-list__main">
                  <div class="history-list__title">
                    {{ item.itinerary.trip_title }}
                  </div>
                  <div class="history-list__meta">
                    <span>{{ item.itinerary.days.length }} 天</span>
                    <span class="history-list__dot">·</span>
                    <span>¥{{ item.itinerary.total_budget_estimate }}</span>
                    <span class="history-list__dot">·</span>
                    <span>{{ formatHistoryTime(item.createdAt) }}</span>
                  </div>
                  <div class="history-list__prompt">{{ item.prompt }}</div>
                </div>
                <button
                  type="button"
                  class="history-list__del"
                  :title="`删除「${item.itinerary.trip_title}」`"
                  :aria-label="`删除「${item.itinerary.trip_title}」`"
                  @click="(e) => deleteHistory(item, e)"
                >
                  <el-icon><Delete /></el-icon>
                </button>
              </li>
            </ul>
          </div>
        </el-popover>
      </div>
    </header>

    <main
      class="planner__main"
      :class="{ 'planner__main--with-explore': explorePanelOpen }"
    >
      <section class="panel panel--input">
        <header class="panel__head">
          <span class="panel__eyebrow">第一步</span>
          <h2 class="panel__title">告诉我你想去哪</h2>
          <p class="panel__hint">
            描述目的地、天数、偏好与预算。越具体，AI 给的方案越合身。
          </p>
        </header>

        <el-input
          v-model="userPrompt"
          type="textarea"
          :rows="6"
          resize="none"
          :disabled="isGenerating"
          maxlength="500"
          show-word-limit
          placeholder="例如：5 月想去北京玩 2 天，喜欢历史和老北京小吃，预算 1500 以内，住前门附近。"
          aria-label="旅行需求描述"
          @keydown="handlePromptKeydown"
        />

        <!-- 示例预设：点击秒填，降低空白页焦虑 -->
        <div class="presets" aria-label="点击直接套用示例">
          <span class="presets__label">不知道写什么？挑一个：</span>
          <div class="presets__grid">
            <button
              v-for="preset in promptPresets"
              :key="preset.city + preset.tag"
              type="button"
              class="preset-chip"
              :disabled="isBusy"
              :title="preset.prompt"
              @click="applyPreset(preset)"
            >
              <span class="preset-chip__dot" :style="{ background: preset.accent }" />
              <span class="preset-chip__city">{{ preset.city }}</span>
              <span class="preset-chip__tag">{{ preset.tag }}</span>
            </button>
          </div>
        </div>

        <div class="panel__actions">
          <el-button
            v-if="!isGenerating"
            type="primary"
            size="large"
            :disabled="isModifying || !userPrompt.trim()"
            @click="handleGenerate"
          >
            <el-icon><MagicStick /></el-icon>
            <span>生成行程</span>
            <kbd class="kbd">⌘↵</kbd>
          </el-button>
          <el-button
            v-else
            type="danger"
            size="large"
            plain
            @click="handleCancelGenerate"
          >
            <el-icon><CircleClose /></el-icon>
            <span>取消生成</span>
          </el-button>
          <el-button
            size="large"
            plain
            :disabled="isBusy || !hasGenerated"
            :title="hasGenerated ? '清空当前行程、输入和全部历史记录' : '当前没有可清空的数据'"
            @click="handleReset"
          >
            清空
          </el-button>
        </div>

        <div class="legend">
          <span
            v-for="meta in legendList"
            :key="meta.type"
            class="legend__item"
          >
            <span
              class="legend__dot"
              :style="{ backgroundColor: meta.color }"
            />
            {{ meta.label }}
          </span>
        </div>
      </section>

      <section class="panel panel--timeline">
        <transition name="fade" mode="out-in">
          <!-- 骨架屏：加载期间显示，模拟 Timeline 结构 -->
          <div v-if="isGenerating" key="skeleton" class="skeleton-wrap">
            <div class="loading-banner">
              <el-icon class="loading-banner__icon is-loading">
                <Loading />
              </el-icon>
              <transition name="phrase" mode="out-in">
                <span :key="currentPhrase" class="loading-banner__text">
                  {{ currentPhrase }}
                </span>
              </transition>
              <span class="loading-banner__elapsed" aria-live="polite">
                已等待 {{ elapsedSeconds }}s · {{ elapsedHint }}
              </span>
            </div>

            <div class="skeleton-trip">
              <el-skeleton animated>
                <template #template>
                  <el-skeleton-item
                    variant="h3"
                    style="width: 60%; height: 24px"
                  />
                  <el-skeleton-item
                    variant="text"
                    style="width: 90%; height: 14px; margin-top: 12px"
                  />
                  <el-skeleton-item
                    variant="text"
                    style="width: 75%; height: 14px; margin-top: 6px"
                  />
                </template>
              </el-skeleton>
            </div>

            <div v-for="d in 2" :key="d" class="day">
              <div class="day__header">
                <el-skeleton animated>
                  <template #template>
                    <el-skeleton-item
                      variant="text"
                      style="width: 180px; height: 16px"
                    />
                  </template>
                </el-skeleton>
              </div>

              <el-timeline>
                <el-timeline-item
                  v-for="i in 4"
                  :key="i"
                  size="large"
                  hollow
                  color="#dcdfe6"
                  :timestamp="''"
                  placement="top"
                >
                  <el-card class="act-card" shadow="never">
                    <el-skeleton animated>
                      <template #template>
                        <div class="skeleton-card__head">
                          <el-skeleton-item
                            variant="rect"
                            style="
                              width: 64px;
                              height: 22px;
                              border-radius: 999px;
                            "
                          />
                          <el-skeleton-item
                            variant="text"
                            style="width: 160px; height: 16px"
                          />
                          <el-skeleton-item
                            variant="text"
                            style="
                              width: 60px;
                              height: 14px;
                              margin-left: auto;
                            "
                          />
                        </div>
                        <el-skeleton-item
                          variant="p"
                          style="width: 95%; height: 14px; margin-top: 12px"
                        />
                        <el-skeleton-item
                          variant="rect"
                          style="
                            width: 100%;
                            height: 36px;
                            margin-top: 12px;
                            border-radius: 6px;
                          "
                        />
                      </template>
                    </el-skeleton>
                  </el-card>
                </el-timeline-item>
              </el-timeline>
            </div>
          </div>

          <!-- 真实 Timeline：加载完成后显示 -->
          <div v-else key="real" class="timeline-wrap">
            <!-- 空态：没生成过任何行程时的引导卡片 -->
            <div
              v-if="!hasGenerated && !itinerary.days.length"
              class="empty-state"
              data-html2canvas-ignore="true"
            >
              <div class="empty-state__mark">
                <span class="brand__mark-dot" />
                <span class="brand__mark-dot brand__mark-dot--accent" />
              </div>
              <h2 class="empty-state__title">准备好出发了吗？</h2>
              <p class="empty-state__text">
                在左侧描述你的旅行想法，按 <kbd class="kbd">⌘↵</kbd> 让 AI
                生成你专属的时间线行程。
              </p>
              <ul class="empty-state__hints">
                <li><span class="empty-state__bullet" />支持多日、含交通 / 美食 / 住宿</li>
                <li><span class="empty-state__bullet" />任意节点鼠标悬停可微调</li>
                <li><span class="empty-state__bullet" />满意后一键保存为长图分享</li>
              </ul>
            </div>

            <!-- 工具栏：放在截图区域外，避免按钮被截入图中。空态下整体隐藏 -->
            <div
              v-if="hasGenerated || itinerary.days.length"
              class="timeline-toolbar"
              data-html2canvas-ignore="true"
            >
              <span class="timeline-toolbar__hint">
                <template v-if="selectionMode">
                  <span class="timeline-toolbar__indicator timeline-toolbar__indicator--accent" />
                  已选 {{ selectedKeys.size }} 项；可一并修改
                </template>
                <template v-else-if="lastModifySummary && lastModifySummary.cascadeCount > 0">
                  <span class="timeline-toolbar__indicator timeline-toolbar__indicator--success" />
                  已修改 {{ lastModifySummary.primaryCount }} 项，AI 顺手联动调整 {{ lastModifySummary.cascadeCount }} 项 · ⌘Z 撤销
                </template>
                <template v-else-if="canUndo || canRedo">
                  <span class="timeline-toolbar__indicator" />
                  修改可一键撤销 · ⌘Z 撤销 / ⌘⇧Z 重做
                </template>
                <template v-else>
                  <span class="timeline-toolbar__indicator" />
                  行程已生成，可保存为长图分享给朋友
                </template>
              </span>
              <div class="timeline-toolbar__actions">
                <el-button
                  :type="explorePanelOpen ? 'primary' : 'default'"
                  :plain="!explorePanelOpen"
                  :disabled="isGenerating"
                  :title="explorePanelOpen ? '关闭探索面板' : '打开景点探索面板：浏览高德全量 POI / AI 攻略推荐，可一键插入或替换'"
                  @click="store.toggleExplorePanel()"
                >
                  <el-icon><MapLocation /></el-icon>
                  <span>{{ explorePanelOpen ? '关闭探索' : '探索景点' }}</span>
                </el-button>
                <el-button
                  :type="selectionMode ? 'primary' : 'default'"
                  :plain="!selectionMode"
                  :disabled="isBusy"
                  :title="selectionMode ? '退出批量选择模式' : '进入批量选择模式：勾选若干节点一起修改'"
                  @click="toggleSelectionMode"
                >
                  <el-icon><Edit /></el-icon>
                  <span>{{ selectionMode ? '退出批量' : '批量选择' }}</span>
                </el-button>
                <el-button
                  :disabled="isBusy || !hasGenerated"
                  title="让 AI 重排整个行程（天数、节点、预算都可调）"
                  @click="openWholeModifyDialog"
                >
                  <el-icon><MagicStick /></el-icon>
                  <span>重排整体</span>
                </el-button>
                <el-button
                  :disabled="!canUndo || isBusy"
                  :title="canUndo ? '回到上一步（⌘Z）' : '当前没有可撤销的修改'"
                  @click="handleUndo"
                >
                  <el-icon><RefreshLeft /></el-icon>
                  <span>撤销</span>
                </el-button>
                <el-button
                  :disabled="!canRedo || isBusy"
                  :title="canRedo ? '重做被撤销的修改（⌘⇧Z）' : '当前没有可重做的修改'"
                  @click="handleRedo"
                >
                  <el-icon><RefreshRight /></el-icon>
                  <span>重做</span>
                </el-button>
                <el-button
                  type="success"
                  :loading="isExporting"
                  :disabled="isBusy"
                  @click="exportAsImage"
                >
                  <el-icon v-if="!isExporting"><Download /></el-icon>
                  <span>{{ isExporting ? '正在生成长图…' : '保存为长图' }}</span>
                </el-button>
              </div>
            </div>

            <!-- 没配高德 Key 的友好引导（一次性提示，不打断主功能） -->
            <div
              v-if="!amapEnabled"
              class="amap-cta"
              data-html2canvas-ignore="true"
              role="note"
            >
              <div class="amap-cta__main">
                <span class="amap-cta__icon" aria-hidden="true">
                  <el-icon><MapLocation /></el-icon>
                </span>
                <div>
                  <strong>解锁地图视图（可选）</strong>
                  <p>
                    配置高德 Key 后，每天的节点会自动显示在地图上，并支持
                    <b>步行 / 驾车 / 公交 / 骑行</b> 4 种交通方式的距离与用时计算。
                  </p>
                </div>
              </div>
              <a
                class="amap-cta__btn"
                href="https://console.amap.com/dev/key/app"
                target="_blank"
                rel="noopener noreferrer"
              >
                去申请 Key
              </a>
            </div>

            <!-- 截图区域：包含 trip 标题/summary + 所有 day timeline。空态下整体隐藏 -->
            <div
              v-if="hasGenerated || itinerary.days.length"
              id="export-timeline-zone"
              class="export-zone"
            >
              <header class="trip">
                <div class="trip__brand">
                  <span class="trip__brand-mark">
                    <span class="brand__mark-dot" />
                    <span class="brand__mark-dot brand__mark-dot--accent" />
                  </span>
                  <span class="trip__brand-name">说走就走 · AI 行程单</span>
                </div>
                <h2 class="trip__title">{{ itinerary.trip_title }}</h2>
                <p class="trip__summary">{{ itinerary.summary }}</p>
                <div class="trip__budget-row">
                  <div
                    v-if="totalDurationMinutes > 0"
                    class="trip__budget trip__budget--duration"
                    title="所有节点 duration_minutes 累加，不含交通时间"
                  >
                    <span class="trip__budget-label">游玩总时长</span>
                    <span class="trip__budget-value">
                      {{ formatTotalDuration(totalDurationMinutes) }}
                    </span>
                  </div>
                  <div class="trip__budget">
                    <span class="trip__budget-label">餐饮 / 门票 / 住宿</span>
                    <span class="trip__budget-value">¥{{ itinerary.total_budget_estimate }}</span>
                  </div>
                  <template v-if="amapEnabled">
                    <span class="trip__budget-plus">+</span>
                    <div
                      class="trip__budget trip__budget--transit"
                      :title="
                        transitCostEstimate.complete
                          ? '基于你选定的交通方式估算（步行/骑行 ¥0）'
                          : `已计入 ${transitCostEstimate.countedSegments}/${transitCostEstimate.totalSegments} 段，待补全后更新`
                      "
                    >
                      <span class="trip__budget-label">
                        交通（{{ transitCostEstimate.countedSegments }}/{{ transitCostEstimate.totalSegments }} 段）
                      </span>
                      <span class="trip__budget-value">¥{{ transitCostEstimate.total }}</span>
                    </div>
                    <span class="trip__budget-plus">=</span>
                    <div class="trip__budget trip__budget--total">
                      <span class="trip__budget-label">合计估算</span>
                      <span class="trip__budget-value">
                        ¥{{ itinerary.total_budget_estimate + transitCostEstimate.total }}
                      </span>
                    </div>
                  </template>
                </div>
              </header>

              <div
                v-for="(day, dayIndex) in itinerary.days"
                :key="day.day"
                class="day"
              >
                <div class="day__header">
                  <div class="day__title">{{ day.date_label }}</div>
                  <div class="day__header-right">
                    <button
                      v-if="!selectionMode"
                      class="day__modify-btn"
                      type="button"
                      data-html2canvas-ignore="true"
                      :disabled="isBusy"
                      :title="`让 AI 重排第 ${dayIndex + 1} 天的所有节点（其他天保持不动）`"
                      @click="openDayModifyDialog(dayIndex)"
                    >
                      <el-icon><Edit /></el-icon>
                      <span>改这一整天</span>
                    </button>
                    <button
                      v-else
                      class="day__modify-btn day__modify-btn--select"
                      type="button"
                      data-html2canvas-ignore="true"
                      :disabled="isBusy"
                      :title="`勾选第 ${dayIndex + 1} 天的所有节点`"
                      @click="selectAllInDay(dayIndex)"
                    >
                      <el-icon><Edit /></el-icon>
                      <span>全选当天</span>
                    </button>
                    <div class="day__total">
                      当日花费约 ¥{{ dailyTotals[dayIndex] }}
                    </div>
                  </div>
                </div>

                <!-- 当天地图：仅在配了高德 Key 时挂载 -->
                <DayMap
                  v-if="amapEnabled"
                  :activities="day.activities"
                  :day-index="dayIndex"
                  :highlighted-index="getDayHover(dayIndex)"
                  @pick-activity="(idx) => onMapPickActivity(dayIndex, idx)"
                  @pick-cluster="(primary, others) => onMapPickCluster(dayIndex, primary, others)"
                />

                <el-timeline>
                  <template v-for="(act, idx) in day.activities" :key="`${day.day}-${idx}`">
                    <el-timeline-item
                      :timestamp="act.time"
                      placement="top"
                      :color="metaOf(act.type).color"
                      :icon="metaOf(act.type).icon"
                      size="large"
                      hollow
                    >
                    <el-card
                      v-loading="store.isActivityModifying(dayIndex, idx)"
                      element-loading-text="AI 正在为你调整这个节点…"
                      element-loading-background="rgba(255, 255, 255, 0.85)"
                      class="act-card"
                      :class="{
                        'act-card--selectable': selectionMode,
                        'act-card--selected': selectionMode && isActivitySelected(dayIndex, idx),
                        'act-card--cascade': store.isActivityCascade(dayIndex, idx),
                      }"
                      shadow="hover"
                      tabindex="0"
                      :data-act-key="`${dayIndex}-${idx}`"
                      :aria-label="`${metaOf(act.type).label}：${act.location}，${act.time}，按 Tab 后可使用修改按钮`"
                      @mouseenter="setDayHover(dayIndex, idx)"
                      @mouseleave="clearDayHover(dayIndex)"
                      @focusin="setDayHover(dayIndex, idx)"
                      @focusout="clearDayHover(dayIndex)"
                      @click="selectionMode && toggleActivitySelection(dayIndex, idx)"
                    >
                      <!-- 选择模式专用 checkbox（左上角，避免遮挡原内容） -->
                      <span
                        v-if="selectionMode"
                        class="act-card__checkbox"
                        data-html2canvas-ignore="true"
                        :title="isActivitySelected(dayIndex, idx) ? '已选中（点击取消）' : '点击勾选'"
                      >
                        <el-checkbox
                          :model-value="isActivitySelected(dayIndex, idx)"
                          :disabled="isBusy"
                          @click.stop
                          @change="toggleActivitySelection(dayIndex, idx)"
                        />
                      </span>

                      <!-- AI 联动浮标：6s 后自动淡出（store 里 setTimeout 控制） -->
                      <transition name="cascade-chip">
                        <span
                          v-if="store.isActivityCascade(dayIndex, idx) && !selectionMode"
                          class="act-card__cascade-chip"
                          data-html2canvas-ignore="true"
                          title="这一项是 AI 为了让前后衔接合理，顺手帮你联动调整的"
                        >
                          <el-icon><Link /></el-icon>
                          <span>已联动</span>
                        </span>
                      </transition>
                      <!-- 「修改」按钮：默认半隐，hover/focus 浮现，
                           键盘 Tab 也能点中（focus-visible 样式）。
                           选择模式下隐藏，避免和"勾选"动作冲突 -->
                      <button
                        v-if="!selectionMode"
                        class="act-card__edit"
                        type="button"
                        data-html2canvas-ignore="true"
                        :disabled="isBusy"
                        :title="
                          isModifying
                            ? '请等待上一个修改完成'
                            : isGenerating
                              ? '正在生成新行程，稍候再试'
                              : '让 AI 重新调整这一项'
                        "
                        :aria-label="`修改：${act.location}`"
                        @click.stop="openSingleModifyDialog(dayIndex, idx, act)"
                      >
                        <el-icon><Edit /></el-icon>
                        <span>修改</span>
                      </button>

                      <div class="act-card__head">
                        <span
                          class="act-card__tag"
                          :style="{
                            color: metaOf(act.type).color,
                            background: metaOf(act.type).softColor,
                          }"
                        >
                          <span
                            class="act-card__tag-dot"
                            :style="{ background: metaOf(act.type).color }"
                          />
                          {{ metaOf(act.type).label }}
                        </span>
                        <el-tooltip
                          v-if="act.address"
                          :content="act.address"
                          placement="top"
                          :show-after="200"
                        >
                          <span class="act-card__location act-card__location--has-addr">
                            {{ act.location }}
                            <el-icon class="act-card__addr-hint" aria-hidden="true">
                              <LocationInformation />
                            </el-icon>
                          </span>
                        </el-tooltip>
                        <span v-else class="act-card__location">
                          {{ act.location }}
                        </span>
                        <span
                          v-if="act.duration_minutes && act.type !== 'hotel'"
                          class="act-card__duration"
                          title="AI 基于真实游玩数据建议的停留时长"
                        >
                          <el-icon><Timer /></el-icon>
                          {{ formatDuration(act.duration_minutes) }}
                        </span>
                        <span class="act-card__cost">
                          <el-icon><Wallet /></el-icon>
                          {{ formatCost(act.cost_estimate) }}
                        </span>
                      </div>
                      <p class="act-card__desc">{{ act.description }}</p>
                      <div class="act-card__tips">
                        <span class="act-card__tips-label">避坑指南</span>
                        <span class="act-card__tips-text">{{ act.tips }}</span>
                      </div>
                    </el-card>
                    </el-timeline-item>

                    <!-- 过渡段：仅在配了 Key、且不是当天最后一项时插入 -->
                    <RouteSegment
                      v-if="amapEnabled && idx < day.activities.length - 1"
                      :from="act"
                      :to="day.activities[idx + 1]"
                      :day-index="dayIndex"
                      :from-index="idx"
                    />
                  </template>
                </el-timeline>
              </div>

              <footer class="export-footer">
                由「说走就走」AI 旅行规划器生成 · {{ new Date().toLocaleDateString('zh-CN') }}
              </footer>
            </div>
          </div>
        </transition>
      </section>

      <!-- ==================== P4: 探索面板（侧栏） ==================== -->
      <transition name="explore-slide">
        <ExplorePanel
          v-if="explorePanelOpen"
          class="planner__explore"
          @insert="handleExploreInsert"
          @replace="handleExploreReplace"
          @close="store.closeExplorePanel()"
        />
      </transition>
    </main>

    <!-- ==================== 选择模式底部浮动条 ==================== -->
    <transition name="fade">
      <div
        v-if="selectionMode"
        class="selection-bar"
        data-html2canvas-ignore="true"
      >
        <div class="selection-bar__info">
          <span class="selection-bar__count">
            <span class="selection-bar__dot" />
            已选 <b>{{ selectedKeys.size }}</b> 项
          </span>
          <span class="selection-bar__hint">
            勾选若干节点 → 点「修改这些节点」让 AI 一并调整
          </span>
        </div>
        <div class="selection-bar__actions">
          <el-button
            :disabled="isBusy || selectedKeys.size === 0"
            @click="clearSelection"
          >
            清空选择
          </el-button>
          <el-button
            type="primary"
            :disabled="isBusy || selectedKeys.size === 0"
            @click="openMultipleModifyDialog"
          >
            <el-icon><MagicStick /></el-icon>
            <span>修改这 {{ selectedKeys.size || '' }} 项</span>
          </el-button>
          <el-button
            plain
            :disabled="isBusy"
            @click="exitSelectionMode"
          >
            退出
          </el-button>
        </div>
      </div>
    </transition>

    <!-- ==================== 修改对话框（兼容 single / multiple / day / whole 四种 scope） ==================== -->
    <el-dialog
      v-model="modifyDialog.visible"
      :title="modifyDialogTitle"
      width="560"
      align-center
      :close-on-click-modal="!isCurrentScopeModifying"
      :close-on-press-escape="!isCurrentScopeModifying"
      :show-close="!isCurrentScopeModifying"
    >
      <div v-if="modifyDialog.scope" class="modify-dialog">
        <!-- 顶部 hint：告诉用户这次能动多少东西 -->
        <p class="modify-dialog__scope-hint">{{ modifyDialogHint }}</p>

        <!-- single：当前节点详细卡片（沿用原来的视觉） -->
        <div
          v-if="modifyDialog.scope.kind === 'single' && modifyDialogTargets[0]"
          class="modify-dialog__current"
          :style="{
            borderLeftColor: metaOf(modifyDialogTargets[0].activity.type).color,
          }"
        >
          <div class="modify-dialog__current-head">
            <span
              class="act-card__tag"
              :style="{
                color: metaOf(modifyDialogTargets[0].activity.type).color,
                background: metaOf(modifyDialogTargets[0].activity.type).softColor,
              }"
            >
              <span
                class="act-card__tag-dot"
                :style="{ background: metaOf(modifyDialogTargets[0].activity.type).color }"
              />
              {{ metaOf(modifyDialogTargets[0].activity.type).label }}
            </span>
            <span class="modify-dialog__time">
              {{ modifyDialogTargets[0].activity.time }}
            </span>
            <span class="modify-dialog__cost">
              {{ formatCost(modifyDialogTargets[0].activity.cost_estimate) }}
            </span>
          </div>
          <div class="modify-dialog__location">
            {{ modifyDialogTargets[0].activity.location }}
          </div>
          <div class="modify-dialog__desc">
            {{ modifyDialogTargets[0].activity.description }}
          </div>
        </div>

        <!-- multiple / day / whole：紧凑的目标节点列表，最多展示 8 行，超出折叠 -->
        <div
          v-else-if="modifyDialogTargets.length"
          class="modify-dialog__list"
        >
          <div class="modify-dialog__list-head">
            目标节点（{{ modifyDialogTargets.length }} 项）
          </div>
          <div class="modify-dialog__list-body">
            <div
              v-for="item in modifyDialogTargets.slice(0, 8)"
              :key="`${item.dayIndex}-${item.activityIndex}`"
              class="modify-dialog__list-item"
            >
              <span
                class="modify-dialog__list-tag"
                :style="{ background: metaOf(item.activity.type).color }"
                :title="metaOf(item.activity.type).label"
                :aria-label="metaOf(item.activity.type).label"
              />
              <span class="modify-dialog__list-day">D{{ item.dayIndex + 1 }}</span>
              <span class="modify-dialog__list-time">{{ item.activity.time }}</span>
              <span class="modify-dialog__list-name">{{ item.activity.location }}</span>
              <span class="modify-dialog__list-cost">
                {{ formatCost(item.activity.cost_estimate) }}
              </span>
            </div>
            <div
              v-if="modifyDialogTargets.length > 8"
              class="modify-dialog__list-more"
            >
              … 还有 {{ modifyDialogTargets.length - 8 }} 项
            </div>
          </div>
        </div>

        <!-- 用户输入修改诉求 -->
        <div class="modify-dialog__form">
          <label class="modify-dialog__label">
            你想怎么修改？
          </label>
          <el-input
            v-model="modifyDialog.instruction"
            type="textarea"
            :rows="4"
            resize="none"
            :disabled="isCurrentScopeModifying"
            :placeholder="modifyDialogPlaceholder"
          />
          <div class="modify-dialog__quick">
            <el-button
              v-for="text in modifyQuickPrompts"
              :key="text"
              size="small"
              round
              :disabled="isCurrentScopeModifying"
              @click="appendQuickPrompt(text)"
            >
              {{ text }}
            </el-button>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button
          :disabled="isCurrentScopeModifying"
          @click="modifyDialog.visible = false"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="isCurrentScopeModifying"
          @click="confirmModify"
        >
          {{ isCurrentScopeModifying ? '正在调整…' : '确认修改' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ==================== P4: 探索面板插入位置 picker ==================== -->
    <el-dialog
      v-model="exploreInsertDialog.visible"
      title="选择插入位置"
      width="480"
      align-center
      :close-on-click-modal="!exploreInsertDialog.submitting"
      :close-on-press-escape="!exploreInsertDialog.submitting"
      :show-close="!exploreInsertDialog.submitting"
    >
      <div v-if="exploreInsertDialog.poi" class="explore-picker">
        <p class="explore-picker__lead">
          把
          <strong>「{{ exploreInsertDialog.poi.name }}」</strong>
          插入到：
        </p>
        <el-form label-position="top" label-width="auto">
          <el-form-item label="哪一天">
            <el-select
              v-model="exploreInsertDialog.dayIndex"
              style="width: 100%"
              :disabled="exploreInsertDialog.submitting"
              @change="onInsertDayChange"
            >
              <el-option
                v-for="(d, i) in itinerary.days"
                :key="i"
                :label="`Day ${d.day} · ${d.date_label}`"
                :value="i"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="放在哪个位置">
            <el-select
              v-model="exploreInsertDialog.position"
              style="width: 100%"
              :disabled="exploreInsertDialog.submitting"
            >
              <el-option
                v-for="opt in insertPositionOptions(exploreInsertDialog.dayIndex)"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
              <el-option
                v-if="itinerary.days[exploreInsertDialog.dayIndex]"
                :label="`放在这一天最末尾`"
                :value="itinerary.days[exploreInsertDialog.dayIndex].activities.length"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <div class="explore-picker__cascade">
          <el-checkbox
            v-model="exploreInsertDialog.cascadeTimes"
            :disabled="exploreInsertDialog.submitting"
          >
            <span class="explore-picker__cascade-label">
              让 AI 顺手把这一天的时间排顺
            </span>
          </el-checkbox>
          <p class="explore-picker__cascade-hint">
            <template v-if="exploreInsertDialog.cascadeTimes">
              插入后会调一次 AI（约 30~90 秒）调整邻居的开始时间，与 P3 联动机制一致；
              一次撤销可整体回滚
            </template>
            <template v-else>
              直接插入，时间基于上一节点自动推算；不满意可单独点节点"修改"再调
            </template>
          </p>
        </div>
      </div>
      <template #footer>
        <el-button
          :disabled="exploreInsertDialog.submitting"
          @click="exploreInsertDialog.visible = false"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="exploreInsertDialog.submitting"
          @click="confirmExploreInsert"
        >
          <el-icon v-if="!exploreInsertDialog.submitting"><LocationInformation /></el-icon>
          {{
            exploreInsertDialog.submitting
              ? 'AI 正在调整时间…'
              : exploreInsertDialog.cascadeTimes
                ? '插入并联动'
                : '插入到这里'
          }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ==================== P4: 探索面板替换目标 picker ==================== -->
    <el-dialog
      v-model="exploreReplaceDialog.visible"
      title="选择要替换的节点"
      width="480"
      align-center
      :close-on-click-modal="!exploreReplaceDialog.submitting"
      :close-on-press-escape="!exploreReplaceDialog.submitting"
      :show-close="!exploreReplaceDialog.submitting"
    >
      <div v-if="exploreReplaceDialog.poi" class="explore-picker">
        <p class="explore-picker__lead">
          用
          <strong>「{{ exploreReplaceDialog.poi.name }}」</strong>
          替换：
        </p>
        <el-form label-position="top" label-width="auto">
          <el-form-item label="哪一天">
            <el-select
              v-model="exploreReplaceDialog.dayIndex"
              style="width: 100%"
              :disabled="exploreReplaceDialog.submitting"
              @change="onReplaceDayChange"
            >
              <el-option
                v-for="(d, i) in itinerary.days"
                :key="i"
                :label="`Day ${d.day} · ${d.date_label}`"
                :value="i"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="哪个节点">
            <el-select
              v-model="exploreReplaceDialog.activityIndex"
              style="width: 100%"
              :disabled="exploreReplaceDialog.submitting"
            >
              <el-option
                v-for="(act, i) in itinerary.days[exploreReplaceDialog.dayIndex]?.activities ?? []"
                :key="i"
                :label="`${act.time} · ${metaOf(act.type).label} · ${act.location}`"
                :value="i"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <div class="explore-picker__cascade">
          <el-checkbox
            v-model="exploreReplaceDialog.cascadeTimes"
            :disabled="exploreReplaceDialog.submitting"
          >
            <span class="explore-picker__cascade-label">
              让 AI 顺手把这一天的时间排顺
            </span>
          </el-checkbox>
          <p class="explore-picker__cascade-hint">
            <template v-if="exploreReplaceDialog.cascadeTimes">
              新节点的时长可能跟原节点不同（比如 2h → 3h），开着这项让 AI
              重新调整邻居的开始时间，避免整天时间崩；一次撤销可整体回滚
            </template>
            <template v-else>
              直接替换，沿用原节点 time / duration；如果时长有较大差异，
              建议手动检查后续节点
            </template>
          </p>
        </div>
      </div>
      <template #footer>
        <el-button
          :disabled="exploreReplaceDialog.submitting"
          @click="exploreReplaceDialog.visible = false"
        >
          取消
        </el-button>
        <el-button
          type="warning"
          :loading="exploreReplaceDialog.submitting"
          @click="confirmExploreReplace"
        >
          <el-icon v-if="!exploreReplaceDialog.submitting"><MagicStick /></el-icon>
          {{
            exploreReplaceDialog.submitting
              ? 'AI 正在调整时间…'
              : exploreReplaceDialog.cascadeTimes
                ? '替换并联动'
                : '确认替换'
          }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ============================================================
 * 新视觉语言（Be.run 风格）：
 * - 米色画布 + 大圆角 + 弱阴影
 * - 主色 = 深咖啡 (--accent)；卡片 = 纯白；avatar/小色块用 yellow / coral / kind-*
 * - 不再用渐变背景；强调"安静的高级感"
 * - 全文件统一使用 :root 中定义的 token，方便后续整体调色
 * ============================================================ */

.planner {
  /* 1440 上限，给两边留呼吸空间；ultra-wide (>1600) 也留白避免太散 */
  max-width: 1440px;
  margin: 0 auto;
  padding: 28px 32px 80px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  text-align: left;
  color: var(--text-primary);
}

/* —— Header：米色画布上贴一张大白卡，左右对齐，去掉所有渐变 —— */
.planner__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 18px 28px;
  background: var(--surface);
  border-radius: var(--radius-card);
  border: 1px solid var(--line-soft);
  box-shadow: var(--shadow-card);
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

/* 品牌标记：两个相依圆点（取代飞机 emoji，呼应"两点一线"的旅行寓意） */
.brand__mark {
  position: relative;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  background: var(--surface-soft);
  border-radius: 14px;
  flex-shrink: 0;
}

.brand__mark-dot {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
}

.brand__mark-dot:first-child {
  transform: translate(-7px, -4px);
}

.brand__mark-dot--accent {
  background: var(--accent-yellow);
  transform: translate(7px, 5px);
}

.brand__text {
  min-width: 0;
}

.brand__text h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.brand__text p {
  margin: 3px 0 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.4;
}

/* 顶部数据胶囊：替换原 badge，分段化展示天数 / 节点 / 预算 */
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 0;
  background: var(--surface-soft);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-pill);
  padding: 8px 6px;
  font-variant-numeric: tabular-nums;
}

.stat-pill__item {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 0 14px;
}

.stat-pill__label {
  font-size: 11.5px;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.stat-pill__value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.stat-pill__divider {
  width: 1px;
  height: 14px;
  background: var(--line);
}

/* —— 主区域：3 段栅格；max-width 调到 1440 后中段更宽 —— */
.planner__main {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 20px;
  align-items: flex-start;
}

/* P4：打开探索面板时变 3 列。整体宽度足够，不会挤压时间线 */
.planner__main--with-explore {
  grid-template-columns: 300px minmax(0, 1fr) 380px;
}

/* 探索面板 slide-in 动画：从右侧滑入 + 透明度淡入 */
.explore-slide-enter-active,
.explore-slide-leave-active {
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.22s ease;
}

.explore-slide-enter-from,
.explore-slide-leave-to {
  transform: translateX(24px);
  opacity: 0;
}

/* P4: 插入 / 替换 picker dialog 内的提示 */
.explore-picker {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.explore-picker__lead {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--el-text-color-primary);
  line-height: 1.55;
}

.explore-picker__lead strong {
  color: var(--el-color-primary);
  font-weight: 600;
}

.explore-picker__hint {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  line-height: 1.55;
}

.explore-picker__cascade {
  margin-top: 8px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
}

.explore-picker__cascade-label {
  font-size: 13.5px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}

.explore-picker__cascade-hint {
  margin: 6px 0 0 24px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.55;
}

/* —— 通用 panel 卡片 —— */
.panel {
  background: var(--surface);
  border-radius: var(--radius-card);
  padding: 28px;
  box-shadow: var(--shadow-card);
  border: 1px solid var(--line-soft);
}

/* 输入面板：sticky 让用户滚动时也能修改输入 */
.panel--input {
  position: sticky;
  top: 20px;
}

/* panel header 三件套：eyebrow（小字标号）+ title + hint */
.panel__head {
  margin-bottom: 16px;
}

.panel__eyebrow {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--text-secondary);
  text-transform: uppercase;
  margin-bottom: 8px;
}

.panel__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  line-height: 1.3;
}

.panel__hint {
  margin: 8px 0 0;
  font-size: 13.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.panel__actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}

.panel__actions .el-button {
  flex: 1;
}

/* 行程类型图例：在输入卡底部，告诉用户颜色含义 */
.legend {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 12px;
  color: var(--text-secondary);
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.legend__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

/* ==================== 时间线顶部工具栏 ==================== */
/* 风格：白色卡片 + 圆角 + 弱阴影。
   响应式：宽度够 → hint + actions 一行；不够 → hint 单行截断、actions 自动换行
   不会在打开探索面板的窄空间下挤变形或溢出 */

.timeline-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  padding: 12px 16px;
  margin-bottom: 18px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card-sm);
  box-shadow: var(--shadow-card);
  flex-wrap: wrap;
}

.timeline-toolbar__hint {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 0;
  flex: 1 1 200px;
  /* 单行截断，避免超长描述把按钮挤到看不见 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 4mm 圆点，用色块代替 emoji 表达"状态" */
.timeline-toolbar__indicator {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.timeline-toolbar__indicator--accent {
  background: var(--accent-yellow);
  box-shadow: 0 0 0 4px var(--accent-yellow-soft);
}

.timeline-toolbar__indicator--success {
  background: var(--kind-attraction);
  box-shadow: 0 0 0 4px var(--kind-attraction-soft);
}

/* 按钮组：始终允许在内部换行；min-width: 0 避免在窄空间里把整组撑爆 toolbar */
.timeline-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
}

/* Element Plus 默认对相邻 .el-button 注入 margin-left:12px，
   在 flex-wrap 后会让换行的第一个按钮额外左移、跟上一行错位。
   这里把按钮间距完全交给 gap：清掉相邻 margin。 */
.timeline-toolbar__actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* 打开探索面板时，时间线中段宽度大约 650~720px，6 个按钮单行肯定放不下。
   做两件事：
   1) 工具栏永远竖排：hint 一行、按钮组一行，按钮组宽度 = toolbar 内宽
   2) 按钮压缩 padding / 字号：哪怕一行容不下也能两行排得下，不再溢出 */
.planner__main--with-explore .timeline-toolbar {
  flex-direction: column;
  align-items: stretch;
}

.planner__main--with-explore .timeline-toolbar__hint {
  flex: 0 0 auto;
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
}

.planner__main--with-explore .timeline-toolbar__actions {
  justify-content: flex-start;
  width: 100%;
}

.planner__main--with-explore .timeline-toolbar__actions :deep(.el-button) {
  padding: 0 14px;
  font-size: 12.5px;
  flex-shrink: 0;
}

/* ==================== 截图区域（白底，html2canvas 目标） ==================== */

.export-zone {
  background: var(--surface);
  padding: 32px;
  border-radius: var(--radius-card);
  border: 1px solid var(--line-soft);
  box-shadow: var(--shadow-card);
  /* 颜色锁死，避免暗色系统主题下截图翻车 */
  --el-text-color-primary: #1f1c19;
  --el-text-color-regular: #423d36;
  --el-text-color-secondary: #7d756c;
  color: var(--text-regular);
}

.trip {
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line-soft);
}

.trip__brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 6px 12px 6px 8px;
  background: var(--surface-soft);
  border-radius: var(--radius-pill);
  font-size: 11.5px;
  color: var(--text-secondary);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.trip__brand-mark {
  position: relative;
  width: 18px;
  height: 18px;
}

.trip__brand-mark .brand__mark-dot {
  width: 7px;
  height: 7px;
}

.trip__brand-mark .brand__mark-dot:first-child {
  transform: translate(0, 1px);
}

.trip__brand-mark .brand__mark-dot--accent {
  transform: translate(7px, 6px);
}

.trip__title {
  margin: 0 0 10px;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  line-height: 1.25;
}

.trip__summary {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.75;
}

.trip__budget-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 18px;
}

/* 预算块统一中性配色（米白 + 深字），强调态用 accent 圆点表达 */
.trip__budget {
  display: inline-flex;
  flex-direction: column;
  padding: 10px 16px;
  background: var(--surface-soft);
  color: var(--text-primary);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card-sm);
  font-size: 13px;
  line-height: 1.3;
  min-width: 0;
}

.trip__budget-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  letter-spacing: 0.02em;
}

.trip__budget-value {
  font-size: 16px;
  font-weight: 700;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}

.trip__budget--duration {
  background: var(--kind-attraction-soft);
  border-color: transparent;
  color: var(--kind-attraction);
}

.trip__budget--duration .trip__budget-value {
  color: var(--kind-attraction);
}

.trip__budget--transit {
  background: var(--kind-transit-soft);
  border-color: transparent;
  color: var(--kind-transit);
}

.trip__budget--transit .trip__budget-value {
  color: var(--kind-transit);
}

/* "合计估算"：唯一一个深咖底，强调焦点 */
.trip__budget--total {
  background: var(--accent);
  color: var(--text-on-dark);
  border-color: transparent;
}

.trip__budget--total .trip__budget-label {
  color: rgba(245, 239, 226, 0.7);
}

.trip__budget--total .trip__budget-value {
  color: var(--text-on-dark);
}

.trip__budget-plus {
  color: var(--text-muted);
  font-size: 16px;
  font-weight: 600;
  user-select: none;
}

.export-footer {
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--line-soft);
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

/* —— 每一天的分组 —— */
.day + .day {
  margin-top: 28px;
}

.day__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 14px 18px;
  background: var(--surface-soft);
  border-radius: var(--radius-card-sm);
  border: 1px solid var(--line-soft);
}

.day__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.005em;
}

.day__total {
  font-size: 13px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.day__header-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

.day__modify-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-regular);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease,
    background 0.15s ease;
}

.day__modify-btn:hover:not(:disabled) {
  color: var(--text-on-dark);
  background: var(--accent);
  border-color: var(--accent);
}

.day__modify-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.day__modify-btn--select:hover:not(:disabled) {
  background: var(--kind-attraction);
  border-color: var(--kind-attraction);
}

.act-card {
  border-radius: var(--radius-card-sm);
  border-color: var(--line-soft);
  background: var(--surface);
  position: relative;
  transition: border-color 0.18s ease, box-shadow 0.18s ease,
    transform 0.18s ease;
}

.act-card:hover {
  border-color: var(--line);
  box-shadow: var(--shadow-card-hover);
}

/* ==================== 选择模式 ==================== */
.act-card--selectable {
  cursor: pointer;
  user-select: none;
  border-color: var(--line);
}

.act-card--selectable:hover {
  border-color: var(--accent);
}

.act-card--selected {
  border-color: var(--accent);
  background: var(--surface-soft);
  box-shadow: 0 0 0 2px var(--accent);
}

/* ==================== AI 联动调整高亮 ==================== */
/* 用 yellow 系突出（与品牌强调色一致），淡黄底 + 描边脉冲 */
.act-card--cascade {
  border-color: var(--accent-yellow);
  background: rgba(244, 204, 77, 0.08);
  box-shadow: 0 0 0 2px rgba(244, 204, 77, 0.45);
  animation: cascade-pulse 1.6s ease-out 1;
}

@keyframes cascade-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(244, 204, 77, 0.7);
  }
  60% {
    box-shadow: 0 0 0 10px rgba(244, 204, 77, 0);
  }
  100% {
    box-shadow: 0 0 0 2px rgba(244, 204, 77, 0.45);
  }
}

.act-card__cascade-chip {
  position: absolute;
  top: -10px;
  left: 18px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-on-dark);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  box-shadow: 0 4px 12px rgba(31, 28, 25, 0.18);
  pointer-events: none;
  user-select: none;
}

.act-card__cascade-chip .el-icon {
  font-size: 11px;
}

/* 联动浮标的进入 / 退出过渡：上滑 + 淡入，淡出再下滑 */
.cascade-chip-enter-active,
.cascade-chip-leave-active {
  transition: opacity 0.4s ease, transform 0.4s ease;
}
.cascade-chip-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.92);
}
.cascade-chip-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

.act-card__checkbox {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.95);
  padding: 0 4px;
  border-radius: 6px;
  pointer-events: auto;
}

/* —— 底部浮动条：选择模式开启时显示 —— */
/* 改为深咖底（呼应主 CTA），不再使用蓝灰 */
.selection-bar {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1500;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 12px 12px 22px;
  background: var(--accent);
  color: var(--text-on-dark);
  border-radius: var(--radius-pill);
  box-shadow: 0 16px 40px rgba(31, 28, 25, 0.28);
  max-width: calc(100vw - 48px);
}

.selection-bar__info {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
}

.selection-bar__count {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.selection-bar__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-yellow);
  box-shadow: 0 0 0 3px rgba(244, 204, 77, 0.25);
}

.selection-bar__count b {
  color: var(--accent-yellow);
  font-size: 15px;
  margin: 0 2px;
}

.selection-bar__hint {
  opacity: 0.7;
  white-space: nowrap;
}

.selection-bar__actions {
  display: flex;
  gap: 8px;
}

.selection-bar__actions .el-button {
  --el-button-bg-color: rgba(245, 239, 226, 0.12);
  --el-button-border-color: rgba(245, 239, 226, 0.2);
  --el-button-text-color: var(--text-on-dark);
  --el-button-hover-bg-color: rgba(245, 239, 226, 0.22);
  --el-button-hover-border-color: rgba(245, 239, 226, 0.3);
  --el-button-hover-text-color: var(--text-on-dark);
}

/* —— hover/focus 浮现的「修改」按钮 —— */
.act-card__edit {
  position: absolute;
  top: 12px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.96);
  color: var(--text-regular);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.18s ease, transform 0.18s ease, color 0.15s ease,
    border-color 0.15s ease, background 0.15s ease;
  z-index: 2;
}

.act-card:hover .act-card__edit:not(:disabled) {
  opacity: 1;
  transform: translateY(0);
}

.act-card__edit:hover:not(:disabled) {
  color: var(--text-on-dark);
  border-color: var(--accent);
  background: var(--accent);
}

.act-card__edit:disabled {
  cursor: not-allowed;
  opacity: 0;
}

/* ==================== 微调对话框 ==================== */

.modify-dialog {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.modify-dialog__scope-hint {
  margin: 0;
  padding: 12px 14px;
  background: var(--surface-soft);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card-sm);
  font-size: 13px;
  color: var(--text-regular);
  line-height: 1.6;
}

.modify-dialog__current {
  background: var(--surface-soft);
  border-left: 3px solid var(--accent-yellow);
  border-radius: var(--radius-card-sm);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 多节点 / 整天 / 整体场景的目标节点紧凑列表 */
.modify-dialog__list {
  background: var(--surface-soft);
  border-radius: var(--radius-card-sm);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.modify-dialog__list-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.modify-dialog__list-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.modify-dialog__list-item {
  display: grid;
  grid-template-columns: auto auto auto 1fr auto;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  padding: 6px 0;
  color: var(--text-regular);
  border-bottom: 1px solid var(--line-soft);
}

.modify-dialog__list-item:last-child {
  border-bottom: none;
}

/* 紧凑列表项 type 标识：用 8mm 色点（取代 emoji），右侧再排时间/名称 */
.modify-dialog__list-tag {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 视觉隐藏但屏幕阅读器可读 */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.modify-dialog__list-day {
  font-weight: 600;
  color: var(--el-text-color-primary);
  font-size: 12px;
}

.modify-dialog__list-time {
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.modify-dialog__list-name {
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.modify-dialog__list-cost {
  color: var(--el-color-danger);
  font-weight: 600;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.modify-dialog__list-more {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
  padding-top: 4px;
}

.modify-dialog__current-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.modify-dialog__time {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.modify-dialog__cost {
  margin-left: auto;
  font-size: 13px;
  color: var(--el-color-danger);
  font-weight: 600;
}

.modify-dialog__location {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.modify-dialog__desc {
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.modify-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modify-dialog__label {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.modify-dialog__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.act-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

/* tag = 圆点 + 文字，柔和 soft 底色，不再用 emoji */
.act-card__tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.act-card__tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.act-card__location {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 16px;
  letter-spacing: -0.005em;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.act-card__location--has-addr {
  cursor: help;
  border-bottom: 1px dashed var(--line);
}

.act-card__addr-hint {
  font-size: 13px;
  color: var(--text-muted);
  opacity: 0.8;
}

.act-card__duration {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 500;
  background: var(--kind-attraction-soft);
  color: var(--kind-attraction);
  border-radius: var(--radius-pill);
  font-variant-numeric: tabular-nums;
}

.act-card__cost {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13.5px;
  color: var(--text-primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.act-card__desc {
  margin: 0 0 12px;
  color: var(--text-regular);
  font-size: 14px;
  line-height: 1.65;
}

.act-card__tips {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--kind-food-soft);
  padding: 10px 13px;
  border-radius: var(--radius-card-sm);
  font-size: 12.5px;
  line-height: 1.55;
}

.act-card__tips-label {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--kind-food);
  letter-spacing: 0.02em;
}

.act-card__tips-text {
  color: var(--text-regular);
}

/* ==================== 加载状态相关样式 ==================== */

.loading-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  margin-bottom: 20px;
  background: var(--surface-soft);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card-sm);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  min-height: 24px;
  box-shadow: var(--shadow-card);
}

.loading-banner__icon {
  font-size: 18px;
}

/* el-icon 自身没有自旋，自己加一个 */
.loading-banner__icon.is-loading,
.el-icon.is-loading {
  animation: planner-spin 1s linear infinite;
}

@keyframes planner-spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-banner__text {
  display: inline-block;
}

.loading-banner__elapsed {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .loading-banner {
    flex-wrap: wrap;
  }
  .loading-banner__elapsed {
    margin-left: 0;
    width: 100%;
  }
}

.skeleton-trip {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.skeleton-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 让骨架的 timeline 节点保持空心圆，避免实心色块在加载态太抢眼 */
.skeleton-wrap :deep(.el-timeline-item__node) {
  background: var(--el-bg-color, #fff);
}

/* ==================== 过渡动画 ==================== */

/* 整块切换：骨架屏 ↔ 真 Timeline */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* 文案轮播：每条文字进出更柔和 */
.phrase-enter-active,
.phrase-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.phrase-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.phrase-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* ==================== 顶部右侧：胶囊指标 + 历史入口 ==================== */
.brand__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* 顶部 GitHub 仓库入口：白底胶囊，与 stat-pill 同语系；hover 翻深色 */
.github-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--surface-soft);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  text-decoration: none;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease,
    transform 0.18s ease;
}

.github-link:hover,
.github-link:focus-visible {
  background: #1f1c19;
  color: #ffffff;
  border-color: #1f1c19;
  transform: translateY(-1px);
  outline: none;
}

.github-link__icon {
  width: 16px;
  height: 16px;
  fill: currentColor;
  flex-shrink: 0;
}

/* 顶部「历史」入口按钮：白底圆角胶囊（与 stat-pill 同语系） */
.history-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  background: var(--accent);
  color: var(--text-on-dark);
  border: none;
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.18s ease, transform 0.18s ease,
    box-shadow 0.18s ease;
  box-shadow: 0 4px 14px rgba(31, 28, 25, 0.18);
}

.history-trigger:hover,
.history-trigger:focus-visible {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(31, 28, 25, 0.25);
  outline: none;
}

.history-trigger__count {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--accent-yellow);
  color: var(--accent);
  border-radius: var(--radius-pill);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.history-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-popover__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.history-popover__clear {
  background: transparent;
  border: none;
  color: var(--el-color-danger);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  font-family: inherit;
}
.history-popover__clear:hover:not(:disabled) {
  background: rgba(245, 108, 108, 0.08);
}
.history-popover__clear:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.history-popover__empty {
  margin: 16px 0 8px;
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
}
.history-popover__empty-hint {
  font-size: 12px;
  opacity: 0.75;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
}

.history-list__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease;
  border: 1px solid transparent;
}
.history-list__item:hover:not(.is-disabled),
.history-list__item:focus-visible:not(.is-disabled) {
  background: var(--surface-soft);
  border-color: var(--line);
  outline: none;
}
.history-list__item.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.history-list__main {
  flex: 1;
  min-width: 0;
}

.history-list__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-list__meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.history-list__dot {
  opacity: 0.55;
}

.history-list__prompt {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.history-list__del {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.15s ease;
}
.history-list__del:hover,
.history-list__del:focus-visible {
  opacity: 1;
  background: rgba(245, 108, 108, 0.1);
  color: var(--el-color-danger);
  outline: none;
}

/* ==================== 示例预设 chip ==================== */
.presets {
  margin-top: 16px;
}

.presets__label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.presets__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

/* preset 卡片：左侧色点 + 城市名 + 风格 tag。两列布局更精致 */
.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 13px;
  background: var(--surface-soft);
  color: var(--text-primary);
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.18s ease, border-color 0.18s ease,
    transform 0.18s ease;
  text-align: left;
}

.preset-chip:hover:not(:disabled),
.preset-chip:focus-visible:not(:disabled) {
  background: var(--surface);
  border-color: var(--line);
  transform: translateY(-1px);
  outline: none;
  box-shadow: var(--shadow-card);
}

.preset-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.preset-chip__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.preset-chip__city {
  font-weight: 600;
  letter-spacing: -0.005em;
}

.preset-chip__tag {
  font-size: 11.5px;
  color: var(--text-secondary);
}

/* ==================== 键盘快捷键提示 kbd ==================== */
.kbd {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgba(245, 239, 226, 0.22);
  border: 1px solid rgba(245, 239, 226, 0.32);
  border-radius: 4px;
  color: inherit;
  vertical-align: middle;
}

/* 浅色按钮里的 kbd 调成米色调 */
.el-button:not([type='primary']) .kbd,
.empty-state .kbd {
  background: var(--surface-sunken);
  border-color: var(--line);
  color: var(--text-secondary);
}

/* ==================== 首屏空态：未生成行程时的引导卡 ==================== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 64px 32px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  color: var(--text-primary);
}

.empty-state__mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 14px 18px;
  background: var(--surface-soft);
  border-radius: var(--radius-pill);
  margin-bottom: 22px;
}

.empty-state__title {
  margin: 0 0 10px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.empty-state__text {
  margin: 0 0 24px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
  max-width: 460px;
}

.empty-state__hints {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.empty-state__hints li {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
}

.empty-state__bullet {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

/* ==================== 高德 Key 缺失引导卡 ==================== */
.amap-cta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 22px;
  margin-bottom: 18px;
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card-sm);
  box-shadow: var(--shadow-card);
}

.amap-cta__main {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

/* 用 element icon 圆形容器替代旧 emoji */
.amap-cta__icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  background: var(--kind-transit-soft);
  color: var(--kind-transit);
  border-radius: 12px;
  font-size: 20px;
}

.amap-cta strong {
  display: block;
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.amap-cta p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.amap-cta__btn {
  flex-shrink: 0;
  padding: 10px 20px;
  background: var(--accent);
  color: var(--text-on-dark);
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  transition: background 0.18s ease, transform 0.18s ease;
}

.amap-cta__btn:hover,
.amap-cta__btn:focus-visible {
  background: var(--accent-hover);
  transform: translateY(-1px);
  outline: none;
}

/* ==================== 卡片闪烁高亮（地图 marker 点击后触发） ==================== */
.act-card--flash {
  animation: card-flash 1.4s ease;
}

@keyframes card-flash {
  0% {
    box-shadow: 0 0 0 0 rgba(244, 204, 77, 0);
  }
  20% {
    box-shadow: 0 0 0 8px rgba(244, 204, 77, 0.45);
    background: rgba(244, 204, 77, 0.08);
  }
  100% {
    box-shadow: var(--shadow-card);
  }
}

/* ==================== 焦点态：键盘可达性 ==================== */
.act-card:focus-within .act-card__edit:not(:disabled),
.act-card__edit:focus-visible:not(:disabled) {
  opacity: 1;
  transform: translateY(0);
}

.act-card__edit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.act-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-card-sm);
}

/* ==================== 响应式 ==================== */

/* 中等宽度（≤1280）：缩窄输入栏给探索栏让路 */
@media (max-width: 1280px) {
  .planner {
    max-width: 100%;
    padding: 24px 24px 64px;
  }
  .planner__main--with-explore {
    grid-template-columns: 280px minmax(0, 1fr) 340px;
    gap: 16px;
  }
}


/* 窄屏：探索面板浮层化，时间线不被挤 */
@media (max-width: 1024px) {
  .planner__main--with-explore {
    grid-template-columns: 320px 1fr;
  }
  .planner__main--with-explore .planner__explore {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    max-height: 100vh;
    border-radius: 0;
    z-index: 50;
    box-shadow: -16px 0 40px rgba(31, 28, 25, 0.2);
  }
}

@media (max-width: 960px) {
  .planner__main,
  .planner__main--with-explore {
    grid-template-columns: 1fr;
  }
  .panel--input {
    position: static;
  }
  .planner__main--with-explore .planner__explore {
    width: 100vw;
    max-width: 100%;
    left: 0;
  }
}

@media (max-width: 768px) {
  .planner {
    padding: 16px 14px 80px;
    gap: 14px;
  }
  .planner__header {
    padding: 14px 18px;
    border-radius: var(--radius-card-sm);
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .brand__text h1 {
    font-size: 19px;
  }
  .brand__text p {
    font-size: 12px;
  }
  .brand__meta {
    width: 100%;
    justify-content: space-between;
  }
  .stat-pill {
    flex: 1;
    justify-content: space-around;
  }
  .stat-pill__item {
    padding: 0 8px;
  }
  /* 窄屏只保留 GitHub 图标，省横向空间给 stat-pill */
  .github-link {
    padding: 8px;
  }
  .github-link__label {
    display: none;
  }
  .panel {
    padding: 18px;
    border-radius: var(--radius-card-sm);
  }
  .panel__title {
    font-size: 18px;
  }
  .panel__actions {
    flex-direction: column;
  }
  .panel__actions .el-button {
    width: 100%;
  }
  .presets__grid {
    grid-template-columns: 1fr 1fr;
  }
  .timeline-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .timeline-toolbar__hint {
    margin-bottom: 6px;
  }
  .timeline-toolbar__actions {
    justify-content: stretch;
  }
  .timeline-toolbar__actions .el-button {
    flex: 1;
  }
  .timeline-toolbar__actions .el-button + .el-button {
    margin-left: 0;
  }
  .act-card__edit {
    opacity: 1 !important;
    transform: none !important;
    top: 10px;
    right: 10px;
    padding: 4px 10px;
    font-size: 11px;
  }
  .day__header {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .export-zone {
    padding: 20px;
  }
  :global(.el-dialog) {
    width: 92vw !important;
    margin: 8vh auto !important;
  }
  .amap-cta {
    flex-direction: column;
    align-items: stretch;
  }
  .amap-cta__btn {
    text-align: center;
  }
  :global(.day-map) {
    height: 240px !important;
  }
}
</style>
