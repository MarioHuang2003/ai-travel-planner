import axios, { AxiosError } from 'axios'
import type { Itinerary } from '../store/useItineraryStore'

const BASE_URL =
  import.meta.env.VITE_LLM_BASE_URL ||
  'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const API_KEY = import.meta.env.VITE_LLM_API_KEY || ''
const MODEL = import.meta.env.VITE_LLM_MODEL || 'glm-5.1'

/** glm-5/glm-5.1/带 thinking 标识的模型才支持 thinking 参数 */
function modelSupportsThinking(model: string): boolean {
  return /glm-5/i.test(model) || /thinking/i.test(model)
}

/** 通过 VITE_LLM_DISABLE_WEB_SEARCH=1 可关闭联网（适用于无搜索权限的端点） */
const WEB_SEARCH_ENABLED = import.meta.env.VITE_LLM_DISABLE_WEB_SEARCH !== '1'

const SYSTEM_PROMPT = `你是一名具备实时联网检索能力的中国本土资深旅行规划师"说走就走"。

# 工作方式（重要）
你**必须先用联网搜索查证真实数据**，再输出行程 JSON。每个景点 / 餐厅 / 酒店都要核实：
- 完整结构化地址（精确到街道门牌号）
- 当下营业 / 开放时间、票价
- 真实建议游玩时长（参考小红书 / 马蜂窝 / 官网常见说法）
- 是否需要预约、有无淡旺季
- 与上一站的合理交通衔接

宁可慢一点，也要给"可以照着走"的真方案。

# 输出格式（必须严格遵守）
你的输出必须是、且只能是一个合法的 JSON 对象，结构如下：

{
  "trip_title": "string，行程总标题，例如『北京经典两日游 · 历史与烟火』",
  "total_budget_estimate": number,  // 单位人民币元，整数；只算餐饮/门票/住宿，**不要**含交通
  "summary": "string，2~3 句话的行程总览，点明主题特色",
  "days": [
    {
      "day": number,                // 第几天，从 1 开始
      "date_label": "string，例如『Day 1 · 周六 · 历史中轴线』",
      "activities": [
        {
          "time": "string，HH:MM 24 小时制，例如『09:30』，按 duration_minutes 自然推算",
          "type": "attraction" | "food" | "transit" | "hotel",
          "location": "string，地点或店铺名（精炼，用作卡片标题）",
          "address": "string，**完整结构化地址**，必须含省/市/区+街道门牌号，例如『北京市东城区景山前街4号』。这是地图能精准定位的关键字段。",
          "duration_minutes": number,  // 在该节点应停留的分钟数（基于联网到的真实数据）
          "description": "string，1~2 句活动描述",
          "cost_estimate": number,  // 该节点本身的花费，单位元，免费写 0
          "tips": "string，避坑/省钱/排队/预约等接地气 tips，1~2 句"
        }
      ]
    }
  ]
}

# 强制规则（违反则视为失败）

## 输出格式
1. **只输出 JSON**，不要任何额外文字、解释、寒暄、思考过程展示。
2. **绝对不要**用 markdown 代码块包裹（不要 \`\`\`json 也不要 \`\`\`）。
3. 字段名、字段类型与定义完全一致；**所有 activity 必须包含 address 与 duration_minutes 两个字段**，不得省略。

## 节点数量
4. 每天 **4~7 个 activity**，按真实游玩节奏分布；不要为凑数硬加。
5. type 只能是：attraction / food / transit / hotel。
6. **transit 节点仅用于跨城市长途**（高铁、飞机、客运 ≥30 分钟）。
   同城短途（地铁、打车、步行）**绝对不要**作为节点出现 —— 系统会自动在每两个节点之间用地图计算路线和用时。
6.1. **类型与名称必须对应**：火车站 / 高铁站 / 动车站 / 汽车站 / 客运站 / 机场 / 航站楼 / 码头 等交通枢纽**只能是 transit**，**绝不能**被标成 hotel 或 attraction（即使你把它当成"今晚下车点"）。hotel 节点的 location 必须是真正的住宿（酒店 / 民宿 / 客栈 / 公寓等）。

## 时长 (duration_minutes) —— 这是路线合理性的关键
7. 必须基于真实"通常游玩时长"，参考典型停留：
   - 餐饮(food): 早餐 30~45 / 正餐 60~90 / 简餐 30~60 / 火锅烤肉 90~120
   - 大型景点(故宫/迪士尼/长城等): 180~360
   - 中型景点(博物馆/寺庙/公园): 90~180
   - 小型打卡(街区/广场/观景台): 30~90
   - 商业街/夜市(前门/宽窄巷子等): 60~120
   - 酒店(hotel): 仅作"今晚住此"标记，duration_minutes 填 0
   - 长途交通(transit): 按实际车程
8. **绝对禁止**：餐饮 ≥120、小型打卡 ≥240 等明显不合理的时长。

## 时间安排 (time)
9. **time 必须按 duration_minutes + 合理交通预留时间自然推算**，不能瞎填：
   - 09:00 故宫(180min) → 12:00 + 15min 步行 = 12:15 午餐
   - 12:15 午餐(75min) → 13:30 + 10min 步行 = 13:40 下一站
10. 时间精度到分钟（如 09:15、13:40、20:50），**严禁全是整点/半点**模板（08:30/12:00/14:00/18:30）。
11. 第一天首项通常 08:30~10:00；末项不晚于 22:00（夜游主题除外）。

## 地点准确性
12. **location**: 真实、具体、地图能搜到的名字。不带箭头/&/、连接，不写"附近/一带/周边"，分店用空格隔开（推荐"南门涮肉 前门店"，避免"南门涮肉(前门店)"）。
13. **address**: 必须是**联网搜到的真实完整地址**，含省/市/区+街道门牌号。这是地图组件能 100% 定位的关键，不要省略也不要编造。

## 内容质量
14. 同一城市的不同需求要差异化（历史/美食/亲子/预算等）。
15. tips 接地气，不同节点 tips 风格要有变化，避免清一色"建议提前预约"。
16. summary 点出**主题特色**（不是复述"你将参观 XX 和 YY"）。
17. cost_estimate 是该节点本身的花费（餐饮/门票/住宿）；交通费**不要**算在内，由系统按地图距离 + 用户选定方式自动估算。
`

export interface LlmServiceOptions {
  /** 用户输入的旅行需求描述 */
  userPrompt: string
  /** AbortController 信号，便于上层取消请求 */
  signal?: AbortSignal
}

/**
 * 修改作用域。决定 LLM 能动多少东西、prompt 怎么描述目标：
 *   - single   只改 1 个节点（hover 单卡片"修改"按钮的入口）
 *   - multiple 用户在选择模式下勾选了 N 个节点（同一天或跨天均可）
 *   - day      整个一天（保留其他天）
 *   - whole    整个行程（可以重排天数 / 数量）
 */
export type ModifyScope =
  | { kind: 'single'; dayIndex: number; activityIndex: number }
  | { kind: 'multiple'; targets: Array<{ dayIndex: number; activityIndex: number }> }
  | { kind: 'day'; dayIndex: number }
  | { kind: 'whole' }

export interface ModifyItineraryOptions {
  /** 当前完整行程，会原样塞给模型作为上下文 */
  currentItinerary: Itinerary
  /** 修改作用域，详见 ModifyScope */
  scope: ModifyScope
  /** 用户的自然语言修改诉求 */
  userInstruction: string
  signal?: AbortSignal
}

const MODIFY_SYSTEM_PROMPT = `你是一名具备实时联网检索能力的中国本土资深旅行规划师"说走就走"。

# 任务
用户已经有一份完整行程，希望针对你看到的 # 修改范围 做调整。
**你必须先用联网搜索查证替换 / 调整后节点的真实信息**（地址、营业时间、票价、典型游玩时长），再输出完整行程 JSON。

# 修改范围解读（必须严格遵守边界）
- scope=single  ：只能改用户指定的那 1 个节点；其他节点保持原样。
- scope=multiple：只能改用户列出的 N 个节点；未列出的节点保持原样。
- scope=day     ：只能在用户指定的那 1 天里调整（可整天重排：增删节点、改顺序、改全部内容）；其他天必须**逐字段**保持原样。
- scope=whole   ：可重排整个行程（增删天数、调整每天节点）；trip_title 与用户最初核心诉求要尽量保留，除非用户明确要换。

# 联动原则（重要——决定行程是否真正"通顺"）
对 scope=single / multiple 这种**有边界**的修改：
1. **主动检查相邻节点**：被指定节点改动后，**必须主动检查**它前后相邻 1~2 项是否出现以下问题，命中任何一条就要联动微调：
   - 餐饮时段不合理（早餐 ≥10:30、午饭 ≤11:00 或 ≥14:00、晚饭 ≤17:30 或 ≥21:00）；
   - 营业 / 开放时间冲突（如博物馆原本 16:00 闭馆，被推到 17:00）；
   - 同地点重复（替换后和已有节点撞点）；
   - 入住 / 长途交通时间被挤压（hotel time 比上一项 end time 早、transit 跨城衔接不上）；
   - 总耗时超过当天合理上限（22:00 还在玩第三个景点等）；
   - 距离突变（替换后路上要走 1 小时但仍预留 10 分钟）。
2. 联动调整时**只动 time / location / address / cost_estimate / tips / description**这几个字段，**不要改 type**，也不要新增/删除节点。
3. 联动改动**只能落在直接相邻 1~2 项**——不要扩散到整天，更不要借机重写无关节点。
4. 没有发现冲突时，未列出节点必须**逐字段保持原样**（time / location / address / type / duration_minutes / description / cost_estimate / tips 一个字都别改）。

对 scope=day / whole：用户已经授权重排，按需调整即可，无需"联动"概念。

# 强制规则（违反则视为失败）
1. 只输出一个合法的 JSON 对象，不要任何额外文字、解释、寒暄、思考过程。
2. 绝对不要使用 markdown 代码块包裹（不要 \`\`\`json 也不要 \`\`\`）。
3. 输出的 JSON 字段、类型必须与原行程完全一致，每个 activity 都包含：
   time / type / location / address / duration_minutes / description / cost_estimate / tips
   —— **address 与 duration_minutes 必填**，旧行程没填的也要补齐（基于联网数据）。
4. type 只能是 attraction / food / transit / hotel；transit 仅用于跨城市长途，同城交通由系统在地图上展示，不要新增同城 transit 节点。
   火车站 / 高铁站 / 机场 / 码头 等交通枢纽**只能是 transit**；hotel 的 location 必须是真正的住宿。
5. **location**：真实、具体、单一、可在高德地图搜到；不要箭头/&/、连多地点，不要"附近/一带"，不要(分店)括号（用空格隔开）。
6. **address**：联网搜到的真实完整地址，含省/市/区+街道门牌号。
7. **duration_minutes**：基于真实游玩时长合理给值（餐饮 30~120、景点按规模 30~360，酒店填 0）。
8. tips 保持"接地气"的避坑建议风格；不同节点 tips 风格要有变化。
9. time 必须按 duration_minutes + 合理交通预留时间自然推算，不能瞎填整点；首项 08:30~10:00，末项不晚于 22:00（夜游主题除外）。
10. 适当根据修改后的成本，更新 total_budget_estimate（仅含餐饮/门票/住宿，不含交通）。
`

/**
 * 把 ModifyScope 渲染成给 LLM 看的"修改范围"提示。
 * 越具体越好——把目标节点的 time/type/location 列清楚，模型才不会找错对象。
 */
function describeScope(itinerary: Itinerary, scope: ModifyScope): string {
  switch (scope.kind) {
    case 'single': {
      const day = itinerary.days[scope.dayIndex]
      const act = day.activities[scope.activityIndex]
      return [
        `- scope: single`,
        `- 目标：第 ${scope.dayIndex + 1} 天 (day=${day.day}, ${day.date_label}) 第 ${scope.activityIndex + 1} 项`,
        `  · ${act.time} ${act.type}「${act.location}」`,
        `  · 当前描述：${act.description}`,
        `  · 当前预估花费：¥${act.cost_estimate}`,
      ].join('\n')
    }
    case 'multiple': {
      const lines = scope.targets.map((t) => {
        const day = itinerary.days[t.dayIndex]
        const act = day.activities[t.activityIndex]
        return `  · 第 ${t.dayIndex + 1} 天第 ${t.activityIndex + 1} 项 ${act.time} ${act.type}「${act.location}」（¥${act.cost_estimate}）`
      })
      return [
        `- scope: multiple`,
        `- 共 ${scope.targets.length} 个目标节点（仅这些可改，其他节点必须保持原样）：`,
        ...lines,
      ].join('\n')
    }
    case 'day': {
      const day = itinerary.days[scope.dayIndex]
      const lines = day.activities.map(
        (a, i) => `  · 第 ${i + 1} 项 ${a.time} ${a.type}「${a.location}」（¥${a.cost_estimate}）`,
      )
      return [
        `- scope: day`,
        `- 目标：第 ${scope.dayIndex + 1} 天 (day=${day.day}, ${day.date_label})；本天共 ${day.activities.length} 项，可整天重排`,
        ...lines,
        `- 其他 ${itinerary.days.length - 1} 天必须保持原样不动`,
      ].join('\n')
    }
    case 'whole': {
      return [
        `- scope: whole`,
        `- 目标：整个行程，共 ${itinerary.days.length} 天，可重排所有内容`,
        `- 原 trip_title：${itinerary.trip_title}`,
      ].join('\n')
    }
  }
}

/**
 * 校验 scope 引用的所有 day/activity 索引存在；不存在直接抛 INVALID_SHAPE。
 */
function assertScopeInRange(itinerary: Itinerary, scope: ModifyScope): void {
  const dayCount = itinerary.days.length
  function checkAct(dayIndex: number, activityIndex: number) {
    const day = itinerary.days[dayIndex]
    if (!day) {
      throw new LlmServiceError('INVALID_SHAPE', `第 ${dayIndex + 1} 天不存在`)
    }
    if (!day.activities[activityIndex]) {
      throw new LlmServiceError(
        'INVALID_SHAPE',
        `第 ${dayIndex + 1} 天的第 ${activityIndex + 1} 个活动不存在`,
      )
    }
  }
  switch (scope.kind) {
    case 'single':
      checkAct(scope.dayIndex, scope.activityIndex)
      return
    case 'multiple':
      if (scope.targets.length === 0) {
        throw new LlmServiceError('INVALID_SHAPE', '至少要选择一个节点才能修改')
      }
      for (const t of scope.targets) checkAct(t.dayIndex, t.activityIndex)
      return
    case 'day':
      if (!itinerary.days[scope.dayIndex]) {
        throw new LlmServiceError('INVALID_SHAPE', `第 ${scope.dayIndex + 1} 天不存在`)
      }
      return
    case 'whole':
      if (dayCount === 0) {
        throw new LlmServiceError('INVALID_SHAPE', '行程为空，无法整体重排')
      }
      return
  }
}

/**
 * 调用大模型按 scope 修改行程，返回**完整的**更新后行程。
 * 内部复用 generateItinerary 的解析与错误体系。
 */
export async function modifyItinerary(
  options: ModifyItineraryOptions,
): Promise<Itinerary> {
  const { currentItinerary, scope, userInstruction } = options
  assertScopeInRange(currentItinerary, scope)

  const userMessage =
    `# 当前完整行程（其余部分请保持原样）\n` +
    `${JSON.stringify(currentItinerary, null, 2)}\n\n` +
    `# 修改范围\n` +
    `${describeScope(currentItinerary, scope)}\n\n` +
    `# 修改要求\n` +
    `${userInstruction}\n\n` +
    `请按规则输出**完整的**更新后行程 JSON。`

  return callChatCompletion({
    systemPrompt: MODIFY_SYSTEM_PROMPT,
    userMessage,
    signal: options.signal,
    // 微调要把整份行程塞进 prompt，深度思考 + 联网搜索情况下耗时更长，给 5 分钟
    timeoutMs: 300_000,
  })
}

// ---------- 探索面板：让大模型推荐 POI ----------

export type ExploreCategory = 'attraction' | 'food' | 'hotel'

/**
 * 探索面板用的轻量 POI 形态。比 Activity 更窄：
 * - 没有 time / 没有 day_index / 没有 type 字段（type 由 category 隐含）
 * - location/address 必填，让用户能直接插入或地图定位
 */
export interface ExploreSuggestion {
  name: string
  address: string
  category: ExploreCategory
  description?: string
  tips?: string
  /** 建议停留时长（分钟），用于"插入"时给出默认 duration */
  duration_minutes?: number
  /** 单次/人均预估花费（元） */
  cost_estimate?: number
}

const EXPLORE_SYSTEM_PROMPT = [
  '你是中国本土资深旅行规划师"说走就走"。',
  '请基于联网搜索为用户在指定城市推荐高质量、真实存在的 POI。',
  '',
  '# 输出格式',
  '严格只输出一个 JSON 数组，不要 markdown 围栏、不要中文标点解释。',
  '数组每一项的字段：',
  '- name: string  地图能搜到的官方/通用名',
  '- address: string  省+市+区+街道门牌号，越精确越好',
  '- category: "attraction" | "food" | "hotel"  必须等于用户请求的类别',
  '- description: string  1~2 句简介',
  '- tips: string  1~2 句避坑/打卡建议（开放时间、交通、提前预约等）',
  '- duration_minutes: number  建议停留分钟数',
  '- cost_estimate: number  人均/单价（元，整数）',
  '',
  '# 推荐原则',
  '1. 真实存在、知名度足够（避免野路子、避免误把街道名当景点）',
  '2. 不重复推荐相同 POI；不与"已在行程中"列表重复',
  '3. attraction 优先经典 + 1~2 个有特色的小众',
  '4. food 优先本地特色，标注菜系/招牌菜（写在 description 或 tips 里）',
  '5. hotel 必须是真实可订的酒店，不要写"XX 区附近"这种笼统说法',
  '6. 默认推荐 8 条；如果用户指定数量则按用户要求',
].join('\n')

/**
 * 调用大模型为指定城市/类别推荐 POI 列表。
 *
 * 返回的 POI 不会自动写入行程；ExplorePanel 让用户决定 "插入" / "替换" / "看地图"。
 */
export async function generateExploreSuggestions(options: {
  city: string
  category: ExploreCategory
  /** 已在当前行程里的地点名，避免重复推荐 */
  existingNames?: string[]
  /** 用户的偏好补充（可选，比如"亲子友好"、"人均 50 以内"） */
  preference?: string
  count?: number
  signal?: AbortSignal
}): Promise<ExploreSuggestion[]> {
  const { city, category, existingNames = [], preference, count = 8 } = options
  const categoryLabel: Record<ExploreCategory, string> = {
    attraction: '景点',
    food: '美食',
    hotel: '酒店',
  }
  const userMessage = [
    `# 任务`,
    `为城市【${city}】推荐 ${count} 个【${categoryLabel[category]}】POI。`,
    '',
    preference ? `# 用户偏好\n${preference}\n` : '',
    existingNames.length
      ? `# 已在行程中的地点（请避开重复）\n${existingNames.join('、')}\n`
      : '',
    `# 输出`,
    `JSON 数组，每项字段满足 system 中的 schema，category 字段必须等于 "${category}"。`,
  ]
    .filter(Boolean)
    .join('\n')

  return callChatRetryable(
    {
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      userMessage,
      signal: options.signal,
      // 探索推荐量轻、用户在等结果，给 90s 已经足够
      timeoutMs: 90_000,
    },
    (raw) => parseExploreSuggestions(raw, category),
  )
}

/**
 * 鲁棒解析 explore 数组：
 * 1. 直接 JSON.parse
 * 2. 失败 → 剥离 markdown fence 重试
 * 3. 失败 → 截取 [...] 区间重试
 * 解析失败抛 INVALID_SHAPE，让上层 UI 给出"再试一次"提示。
 */
function parseExploreSuggestions(
  raw: string,
  expectedCategory: ExploreCategory,
): ExploreSuggestion[] {
  const candidates: string[] = [raw]
  const fenceStripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (fenceStripped !== raw) candidates.push(fenceStripped)
  const bracketStart = raw.indexOf('[')
  const bracketEnd = raw.lastIndexOf(']')
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    candidates.push(raw.slice(bracketStart, bracketEnd + 1))
  }

  let parsed: unknown = null
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c)
      break
    } catch {
      // 继续尝试下一个候选
    }
  }
  if (!Array.isArray(parsed)) {
    throw new LlmServiceError('PARSE', '解析探索推荐失败：模型未返回数组')
  }
  const items: ExploreSuggestion[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const name = typeof it.name === 'string' ? it.name.trim() : ''
    const address = typeof it.address === 'string' ? it.address.trim() : ''
    if (!name || !address) continue
    items.push({
      name,
      address,
      // 即便模型返回 "餐饮" 之类怪东西，也以请求时的 category 兜底
      category: expectedCategory,
      description: typeof it.description === 'string' ? it.description : undefined,
      tips: typeof it.tips === 'string' ? it.tips : undefined,
      duration_minutes:
        typeof it.duration_minutes === 'number' && it.duration_minutes > 0
          ? Math.round(it.duration_minutes)
          : undefined,
      cost_estimate:
        typeof it.cost_estimate === 'number' && it.cost_estimate >= 0
          ? Math.round(it.cost_estimate)
          : undefined,
    })
  }
  if (!items.length) {
    throw new LlmServiceError('INVALID_SHAPE', '解析探索推荐失败：数组里没有合法 POI')
  }
  return items
}

/**
 * LLM 服务可识别的错误类型。组件可据此分类提示。
 */
export class LlmServiceError extends Error {
  readonly code:
    | 'MISSING_API_KEY'
    | 'NETWORK'
    | 'HTTP'
    | 'EMPTY_RESPONSE'
    | 'PARSE'
    | 'INVALID_SHAPE'
    | 'ABORTED'
  readonly cause?: unknown

  constructor(
    code: LlmServiceError['code'],
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'LlmServiceError'
    this.code = code
    this.cause = cause
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string
      content?: string
    }
  }>
  error?: {
    message?: string
    code?: string | number
  }
}

/**
 * 调用大模型生成行程（首次生成）。
 *
 * 全流程：构造请求 → 调用 LLM → 提取 JSON → 校验 shape → 返回 Itinerary。
 * 任何阶段失败都会抛出 LlmServiceError，调用方可根据 code 给出对应 UI 提示。
 */
export async function generateItinerary(
  options: LlmServiceOptions,
): Promise<Itinerary> {
  return callChatCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: options.userPrompt,
    signal: options.signal,
    // 首次生成：联网搜索+深度思考下，多日行程通常 60~180s，给 4 分钟兜底
    timeoutMs: 240_000,
  })
}

interface CallOptions {
  systemPrompt: string
  userMessage: string
  signal?: AbortSignal
  /** 单次请求的 HTTP timeout (ms)，默认 120s */
  timeoutMs?: number
  /**
   * 网络/超时类错误自动重试次数（不计第一次）。
   * 仅对 NETWORK / 超时类错误重试；HTTP 4xx/5xx、用户取消、解析失败都不重试。
   */
  maxRetries?: number
}

/**
 * 内部统一的对话补全调用：负责认证检查、HTTP 请求、错误归类、解析为 Itinerary。
 * generateItinerary / modifyItinerary 都用它，保证 prompt 不同但行为一致。
 *
 * 失败重试策略：
 * - 用户主动 abort / HTTP 4xx (鉴权/参数等业务错) / 解析失败：**不重试**
 * - timeout / 网络抖动 / HTTP 5xx：最多重试 maxRetries 次，指数退避 1s → 2s
 */
async function callChatCompletion(options: CallOptions): Promise<Itinerary> {
  return callChatRetryable(options, parseItinerary)
}

/**
 * 通用版调用：自定义 raw → T 的解析器，复用同一套认证/重试/错误归类。
 * 用于探索面板里 LLM 返回 POI 数组（不是 Itinerary）等场景。
 */
async function callChatRetryable<T>(
  options: CallOptions,
  parse: (raw: string) => T,
): Promise<T> {
  if (!API_KEY) {
    throw new LlmServiceError(
      'MISSING_API_KEY',
      '尚未配置大模型 API Key。请在项目根目录创建 .env.local，并填入 VITE_LLM_API_KEY。',
    )
  }

  const maxRetries = options.maxRetries ?? 1
  let lastErr: LlmServiceError | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new LlmServiceError('ABORTED', '已取消生成')
    }
    try {
      const raw = await callOnceRaw(options)
      return parse(raw)
    } catch (err) {
      const normalized = err instanceof LlmServiceError ? err : new LlmServiceError(
        'NETWORK',
        err instanceof Error ? err.message : '未知错误',
        err,
      )
      lastErr = normalized
      if (!isRetryable(normalized)) {
        throw normalized
      }
      if (attempt >= maxRetries) {
        throw enrichRetryError(normalized, attempt + 1)
      }
      const backoff = 1000 * Math.pow(2, attempt)
      console.warn(
        `[llmService] 第 ${attempt + 1} 次请求失败 (${normalized.code})，${backoff}ms 后重试`,
        normalized.message,
      )
      await sleep(backoff, options.signal)
    }
  }

  throw lastErr ?? new LlmServiceError('NETWORK', '请求失败')
}

/** 单次 HTTP 调用：返回原始 content 字符串，不做业务解析；异常归类成 LlmServiceError */
async function callOnceRaw(options: CallOptions): Promise<string> {
  let raw = ''
  try {
    const body: Record<string, unknown> = {
      model: MODEL,
      // 0.85 让相同输入也能产出有差异化的行程结构与时间安排
      temperature: 0.85,
      messages: [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userMessage },
      ],
    }

    // 注：thinking 模式与 response_format=json_object 在智谱 API 上互斥，
    // 我们这里靠 prompt 约束 + parseItinerary 的 fence 兜底来保证 JSON 输出，
    // 不再使用 json_object 强制模式（避免 invalid_request_error）。

    if (WEB_SEARCH_ENABLED) {
      // 智谱 web_search 工具：让模型在生成前/中调用搜索查证地址、票价、营业时间
      body.tools = [
        {
          type: 'web_search',
          web_search: {
            enable: true,
            search_engine: 'search_pro',
            search_result: true,
          },
        },
      ]
    }

    if (modelSupportsThinking(MODEL)) {
      // 启用深度思考；智谱 GLM-5/5.1 接受 enabled / disabled
      body.thinking = { type: 'enabled' }
    }

    const { data } = await axios.post<ChatCompletionResponse>(BASE_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      signal: options.signal,
      timeout: options.timeoutMs ?? 240_000,
    })

    if (data?.error?.message) {
      throw new LlmServiceError(
        'HTTP',
        `大模型返回错误：${data.error.message}`,
        data.error,
      )
    }

    raw = data?.choices?.[0]?.message?.content?.trim() ?? ''
    if (!raw) {
      throw new LlmServiceError('EMPTY_RESPONSE', '大模型返回了空内容，请稍后重试。')
    }
  } catch (err) {
    if (err instanceof LlmServiceError) throw err
    // 用户主动 abort：不当作网络错误，抛专用 code 让上层静默处理
    if (
      axios.isCancel(err) ||
      (err as { name?: string })?.name === 'CanceledError' ||
      (err as { name?: string })?.name === 'AbortError' ||
      options.signal?.aborted
    ) {
      throw new LlmServiceError('ABORTED', '已取消生成', err)
    }
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError<{ error?: { message?: string } }>
      const status = ax.response?.status
      const apiMsg = ax.response?.data?.error?.message
      // 超时单独识别，给更明确的文案
      const isTimeout = ax.code === 'ECONNABORTED' || /timeout/i.test(ax.message)
      if (status) {
        throw new LlmServiceError(
          'HTTP',
          `调用大模型失败（HTTP ${status}）：${apiMsg ?? ax.message}`,
          err,
        )
      }
      if (isTimeout) {
        throw new LlmServiceError(
          'NETWORK',
          `请求超时：模型响应时间超过预期。可能是网络慢或当前模型负载高。`,
          err,
        )
      }
      throw new LlmServiceError(
        'NETWORK',
        `网络异常：${ax.message}。请检查网络或代理。`,
        err,
      )
    }
    throw new LlmServiceError(
      'NETWORK',
      err instanceof Error ? err.message : '未知网络错误',
      err,
    )
  }

  return raw
}

/** 哪些错误值得重试 */
function isRetryable(err: LlmServiceError): boolean {
  if (err.code === 'NETWORK') return true
  if (err.code === 'EMPTY_RESPONSE') return true
  // HTTP 5xx 也重试（4xx 是业务错，重试无意义）
  if (err.code === 'HTTP') {
    const status = (err.cause as AxiosError | undefined)?.response?.status
    return typeof status === 'number' && status >= 500 && status < 600
  }
  return false
}

/** 全部重试都失败时，给用户一个更友好的、包含建议的错误 */
function enrichRetryError(err: LlmServiceError, attempts: number): LlmServiceError {
  const suffix = attempts > 1 ? `（已自动重试 ${attempts - 1} 次）` : ''
  let hint = ''
  if (err.code === 'NETWORK' && /超时|timeout/i.test(err.message)) {
    hint = '\n建议：① 检查网络是否稳定；② 描述短一点（去掉过多偏好）；③ 稍后再试。'
  } else if (err.code === 'NETWORK') {
    hint = '\n建议：检查网络/代理后重试。'
  } else if (err.code === 'EMPTY_RESPONSE') {
    hint = '\n建议：换个描述方式重试。'
  }
  return new LlmServiceError(
    err.code,
    `${err.message}${suffix}${hint}`,
    err.cause,
  )
}

/** 可被 abort 中断的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmServiceError('ABORTED', '已取消生成'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmServiceError('ABORTED', '已取消生成'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 鲁棒解析：先尝试直接 parse；失败后剥离 markdown fence，
 * 再做 "首个 { 到末尾 }" 的截取，最终用结构校验确保字段完整。
 *
 * 导出便于单测复用。
 */
export function parseItinerary(raw: string): Itinerary {
  const candidates = collectJsonCandidates(raw)
  let lastErr: unknown = null

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      assertItinerary(parsed)
      return parsed
    } catch (err) {
      lastErr = err
    }
  }

  console.error('[llmService] 无法解析 LLM 返回内容：', raw)
  if (lastErr instanceof LlmServiceError) throw lastErr
  throw new LlmServiceError(
    'PARSE',
    '大模型返回的内容无法解析为 JSON，请稍后重试或换个描述。',
    lastErr,
  )
}

/**
 * 生成多个解析候选，按可信度从高到低尝试：
 * 1) 原文本
 * 2) 去掉 markdown 代码块包裹
 * 3) 提取 ```json ... ``` 块内的内容（思考模式下常见）
 * 4) 首个 { 到最后一个 } 的截取
 * 5) brace-balance 扫描出第一个完整 JSON 对象（最鲁棒）
 */
function collectJsonCandidates(raw: string): string[] {
  const list: string[] = []
  const seen = new Set<string>()
  const push = (s: string) => {
    const t = s.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      list.push(t)
    }
  }
  const trimmed = raw.trim()
  push(trimmed)

  // 去掉首尾 ```json ... ``` 包裹
  push(
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
  )

  // 抽取文本中第一个 ```json ... ``` 块（思考模式输出常见）
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenceMatch?.[1]) push(fenceMatch[1])

  // 首个 { 到最后一个 } 截取（粗糙但有时管用）
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  // brace-balance 扫描：从第一个 { 起，按嵌套层级取出第一个完整对象
  const balanced = extractFirstBalancedObject(trimmed)
  if (balanced) push(balanced)

  return list
}

/**
 * 简易 brace-balance 扫描，能正确处理字符串内的转义引号。
 * 主要用于从模型的"思考过程 + JSON 结果"混合文本里抠出 JSON。
 */
function extractFirstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 结构校验：只校验关键字段存在并具有正确类型。
 * 不通过则抛 LlmServiceError('INVALID_SHAPE')，保证传给 UI 的对象一定可渲染。
 */
function assertItinerary(value: unknown): asserts value is Itinerary {
  if (!value || typeof value !== 'object') {
    throw new LlmServiceError('INVALID_SHAPE', '行程数据缺少根对象')
  }
  const v = value as Record<string, unknown>
  if (typeof v.trip_title !== 'string') {
    throw new LlmServiceError('INVALID_SHAPE', '行程数据缺少 trip_title')
  }
  if (typeof v.summary !== 'string') {
    throw new LlmServiceError('INVALID_SHAPE', '行程数据缺少 summary')
  }
  if (typeof v.total_budget_estimate !== 'number') {
    throw new LlmServiceError(
      'INVALID_SHAPE',
      '行程数据缺少 total_budget_estimate',
    )
  }
  if (!Array.isArray(v.days) || v.days.length === 0) {
    throw new LlmServiceError('INVALID_SHAPE', '行程数据缺少 days 数组')
  }
  for (const [idx, dayUnknown] of v.days.entries()) {
    if (!dayUnknown || typeof dayUnknown !== 'object') {
      throw new LlmServiceError('INVALID_SHAPE', `第 ${idx + 1} 天数据非对象`)
    }
    const day = dayUnknown as Record<string, unknown>
    if (typeof day.day !== 'number' || typeof day.date_label !== 'string') {
      throw new LlmServiceError(
        'INVALID_SHAPE',
        `第 ${idx + 1} 天缺少 day / date_label`,
      )
    }
    if (!Array.isArray(day.activities) || day.activities.length === 0) {
      throw new LlmServiceError(
        'INVALID_SHAPE',
        `第 ${idx + 1} 天 activities 为空`,
      )
    }
    // 对每个 activity 做轻量 normalize，让旧模型 / 缺字段输出也能渲染：
    //   - address / duration_minutes 缺失补默认
    //   - duration_minutes 类型修正为 number
    for (const a of day.activities as Array<Record<string, unknown>>) {
      if (typeof a.location !== 'string') a.location = String(a.location ?? '')
      if (typeof a.address !== 'string') a.address = ''
      if (typeof a.duration_minutes !== 'number') {
        const n = Number(a.duration_minutes)
        a.duration_minutes = Number.isFinite(n) && n > 0
          ? n
          : defaultDurationByType(a.type as string | undefined)
      }
      if (typeof a.cost_estimate !== 'number') {
        const n = Number(a.cost_estimate)
        a.cost_estimate = Number.isFinite(n) ? n : 0
      }
    }
  }
}

/** type 缺 duration 时的兜底典型时长 */
function defaultDurationByType(type: string | undefined): number {
  switch (type) {
    case 'food':
      return 60
    case 'attraction':
      return 90
    case 'hotel':
      return 0
    case 'transit':
      return 60
    default:
      return 60
  }
}
