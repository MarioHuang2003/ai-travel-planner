/**
 * 高德地图业务服务层。
 *
 * 对外暴露：
 * - geocodeLocation(location, cityHint?)  地名 → 坐标
 * - geocodeBatch(...) 批量
 * - planRoute(from, to, mode)  路径规划
 * - getCachedGeocode / getCachedRoute  纯查缓存（不发起请求）
 *
 * 缓存策略：
 * - geocode：永久缓存（坐标基本不会变）
 * - route：24h TTL（公交时刻表会变化）
 * 都同步落 localStorage，保证刷新不丢。
 */
import {
  loadAMap,
  extractCity,
  cityTier,
  type AMapNamespace,
  type AMapPoi,
  type TransitMode,
  type RoutingResult,
} from '../utils/amapLoader'
import { readStorage, writeStorage } from '../utils/storage'

// ==================== 类型 ====================
export interface Coords {
  lng: number
  lat: number
  /** 高德返回的标准化地名，可能比用户输入更精确 */
  formattedName?: string
  /** 该 POI 所在城市 */
  city?: string
}

export type GeocodeStatus = 'pending' | 'ok' | 'fail'

export interface GeocodeResult {
  status: GeocodeStatus
  coords?: Coords
  error?: string
  /** 缓存时间戳（ms）。仅 fail 用 TTL，ok 永久缓存 */
  cachedAt?: number
}

export interface RouteResult {
  status: 'pending' | 'ok' | 'fail' | 'unreachable'
  /** 米 */
  distance?: number
  /** 秒 */
  duration?: number
  error?: string
  /** 缓存时间戳，用于 TTL */
  cachedAt?: number
}

// ==================== 缓存 ====================
// v4: 加超时 + 修危险 regex 后再 bump 一次，让旧的可疑缓存彻底重新计算
const KEY_GEOCODE = 'amap:geocode:v4'
const KEY_ROUTE = 'amap:route:v1'
const ROUTE_TTL_MS = 24 * 3600 * 1000
/**
 * fail 短缓存：5 分钟内不重复打高德，
 * 5 分钟后自动重试（用户切回页面通常都过了）。
 * 用户主动点重试时直接 clearGeocode 跳过 TTL。
 */
const GEOCODE_FAIL_TTL_MS = 5 * 60 * 1000

/**
 * SDK 单次请求最长容忍时间。
 * 高德 PlaceSearch / Geocoder 正常 0.5~2s 即返回，5s 还没回基本是卡了，
 * 提前 fallback 让用户感知更快。
 */
const SDK_CALL_TIMEOUT_MS = 5000
/** geocodeLocation 整体兜底超时，避免多步串行加起来无限拖 */
const GEOCODE_TOTAL_TIMEOUT_MS = 15_000
/** 路径规划单次超时 */
const ROUTE_CALL_TIMEOUT_MS = 8000

/**
 * 给任意 promise 套一个超时；超时返回 fallbackValue（不抛异常，避免上层 try/catch 散落各处）。
 * 关键作用：避免高德 SDK callback 不调时整个 await 链 hang 死。
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    p.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // promise reject 也视为失败 + 走 fallback，不让异常冒到上层
        console.error('[amapService] withTimeout caught reject:', err)
        resolve(fallback)
      },
    )
  })
}

/**
 * key 用 "address|location|城市" 防止同名异城（如「鼓楼」北京和南京都有）。
 * 把 address 放在前面，因为 LLM 联网搜来的 address 是最权威的指纹，
 * 同一 location 在不同上下文下 address 可能不同（如不同分店）。
 */
function geocodeKey(location: string, city?: string, address?: string): string {
  return `${(address ?? '').trim()}|${location.trim()}|${city ?? ''}`
}

/** route 缓存 key 用 "fromCoords|toCoords|mode"，坐标精度截到 5 位足够 */
function routeKey(from: Coords, to: Coords, mode: TransitMode): string {
  const r = (n: number) => n.toFixed(5)
  return `${r(from.lng)},${r(from.lat)}|${r(to.lng)},${r(to.lat)}|${mode}`
}

const geocodeCache: Record<string, GeocodeResult> = readStorage(KEY_GEOCODE, {})
const routeCache: Record<string, RouteResult> = readStorage(KEY_ROUTE, {})

// 只持久化 ok / 未过期 fail（pending 不存，避免下次启动看到死掉的 pending）
let geocodeFlushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleGeocodeFlush() {
  if (geocodeFlushTimer) return
  geocodeFlushTimer = setTimeout(() => {
    geocodeFlushTimer = null
    const now = Date.now()
    const persistable: Record<string, GeocodeResult> = {}
    for (const [k, v] of Object.entries(geocodeCache)) {
      if (v.status === 'pending') continue
      // fail 应用 TTL；ok 永久存
      if (v.status === 'fail' && v.cachedAt && now - v.cachedAt > GEOCODE_FAIL_TTL_MS) continue
      persistable[k] = v
    }
    writeStorage(KEY_GEOCODE, persistable)
  }, 500)
}

/** fail 缓存是否仍在 TTL 内（在 TTL 内才算"已知失败"，否则视为 cache miss 重新尝试） */
function isFreshFailCache(v: GeocodeResult | undefined): boolean {
  if (!v || v.status !== 'fail') return false
  if (!v.cachedAt) return false
  return Date.now() - v.cachedAt < GEOCODE_FAIL_TTL_MS
}

let routeFlushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRouteFlush() {
  if (routeFlushTimer) return
  routeFlushTimer = setTimeout(() => {
    routeFlushTimer = null
    const now = Date.now()
    const persistable: Record<string, RouteResult> = {}
    for (const [k, v] of Object.entries(routeCache)) {
      if (v.status === 'pending') continue
      // 写盘时同时清掉过期的，避免 localStorage 越来越大
      if (v.cachedAt && now - v.cachedAt > ROUTE_TTL_MS) continue
      persistable[k] = v
    }
    writeStorage(KEY_ROUTE, persistable)
  }, 500)
}

// ==================== Geocode ====================
/**
 * 把 LLM 给的"自由文本式 location"清洗成一组从精确到模糊的搜索候选。
 *
 * LLM 常见杂质：
 *   "北京南站 → 天坛东门"   → 取第一段「北京南站」
 *   "前门大街 & 大栅栏"      → 取第一段「前门大街」
 *   "南门涮肉(前门店)"       → 「南门涮肉前门店」「南门涮肉」
 *   "故宫博物院附近"          → 「故宫博物院」
 *
 * 返回顺序：原文 → 多分隔符首段 → 去括号 → 去后缀。
 * 调用方按顺序试，第一个命中即返回，避免一次次请求烦的同时保证识别率。
 */
export function buildSearchCandidates(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (s: string | undefined) => {
    const t = s?.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }

  const original = raw.trim()
  push(original)

  // 1) 多地点分隔符 → 取第一段（处理 "北京南站 → 天坛"、"前门 & 大栅栏"）
  const SEPARATORS = /(?:→|➝|➔|⇒|->|\/|、|,|，|&|\+|\s*(?:和|与|及|至|到)\s*)/
  const firstSeg = original.split(SEPARATORS)[0].trim()
  push(firstSeg)

  // 2) 去括号注释 + 去描述性后缀（一次性处理，少一个候选）
  const TRAILING = /(附近|周边|一带|一线|沿线|景区|景点|区域)$/
  const cleaned = firstSeg
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(TRAILING, '')
    .trim()
  push(cleaned)

  // 最多 3 个候选，防止失败节点的总等待时间爆炸
  return out.slice(0, 3)
}

/**
 * 地址候选清洗：保留原地址作为首选，同时产出 Geocoder 更稳定识别的变体。
 * 例：
 *  - "上海市浦东新区川沙镇黄赵路310号（迪士尼度假区）"
 *    -> "上海市浦东新区川沙镇黄赵路310号"  （首选）
 *    -> "浦东新区川沙镇黄赵路310号"        （省去市，让市靠 cityHint 兜）
 *    -> "上海市黄赵路310号"                （省去镇，对城市级路名更友好）
 *
 * 设计原则：
 * - 不再用「无锚点正则」去删字，避免产出畸形片段（如把"川沙镇"删成空）。
 * - 每个变体都带门牌或路名，确保仍然是有效地址。
 */
function buildAddressCandidates(rawAddress: string, cityHint?: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (v: string | undefined) => {
    const s = v?.trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  if (!rawAddress) return out

  // 1) 标准化：去括号注释 + 去多余空白 + 去"中国/省"前缀
  const base = rawAddress
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/\s+/g, '')
    .replace(/^(中国|中华人民共和国)?[\u4e00-\u9fa5]{2,3}省/, '')
    .replace(/^(中国|中华人民共和国)/, '')
    .trim()
  push(base)

  // 2) 去镇/乡段（让区/县后直接接路名），对城市级路名更友好
  //    用锚点正则避免误删
  const noTown = base.replace(/((?:区|县))[\u4e00-\u9fa5]{1,6}(?:镇|乡)/, '$1')
  push(noTown)

  // 3) 补 cityHint 前缀（如果首选没包含）
  if (cityHint && base) {
    const cityStripped = cityHint.replace(/[市州县]$/u, '')
    if (!base.includes(cityHint) && !base.includes(cityStripped)) {
      push(`${cityHint}${base}`)
    }
  }

  // 最多 3 个候选；4+ 个候选每个 5s 超时会让用户感知很卡
  return out.slice(0, 3)
}

function stripCitySuffix(city: string): string {
  return city.replace(/[市州县]$/u, '').trim()
}

function isSameCity(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return true
  const e = stripCitySuffix(expected)
  const a = stripCitySuffix(actual)
  return e === a || e.includes(a) || a.includes(e)
}

/**
 * 抽取地址中的高价值锚点，用于验证 Geocoder 返回是否“真的是这个地址”：
 * - 行政区：XX区 / XX县
 * - 道路：XX路 / XX街 / XX大道 / XX巷 / XX弄
 * - 门牌：123号
 */
function extractAddressSignals(address: string): {
  district?: string
  road?: string
  houseNo?: string
} {
  const plain = address.replace(/\s+/g, '')
  const district = plain.match(/([\u4e00-\u9fa5]{2,}(?:区|县))/u)?.[1]
  const road = plain.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,}(?:路|街|大道|巷|弄))/u)?.[1]
  const houseNo = plain.match(/(\d+号)/u)?.[1]
  return { district, road, houseNo }
}

/**
 * Geocoder 结果校验：
 * 1) 城市必须匹配（若有 cityHint）；
 * 2) 输入地址中抽到的锚点（区/路/号）必须尽量在返回地址中命中。
 *
 * 作用：防止 Geocoder 把「安仁街137号」误解到同名外地街道，
 * 或把地址糊成别的 POI 仍被当成成功缓存。
 */
function isGeocoderResultReliable(
  inputAddress: string,
  formattedAddress: string,
  cityHint?: string,
  resolvedCity?: string,
): boolean {
  if (!isSameCity(cityHint, resolvedCity)) return false
  if (!inputAddress) return true
  const inSig = extractAddressSignals(inputAddress)
  const formatted = formattedAddress.replace(/\s+/g, '')

  // 路名缺失：路是最重要的信号，必须命中
  if (inSig.road && !formatted.includes(inSig.road)) return false

  // 行政区缺失：不强制（一些地址同区不重名时高德会省略区）
  // 仅当行政区+路名都缺时才视为彻底跑偏（已在路名校验中处理）

  // 门牌缺失：不直接判不可信。
  // 高德 formattedAddress 经常省略 “号” 字（"北京西路510" vs "北京西路510号"），
  // 只要数字部分对得上就接受。
  if (inSig.houseNo) {
    const num = inSig.houseNo.replace(/号$/u, '')
    const houseInResult =
      formatted.includes(inSig.houseNo) ||
      new RegExp(`(?:^|[^0-9])${num}(?:号|$|[^0-9])`, 'u').test(formatted)
    if (!houseInResult) {
      // 没号就算缺一个弱信号，但路名已对，不直接拒
      return true
    }
  }
  return true
}

/**
 * 单个地名 → 坐标。先查缓存，命中直接返。
 *
 * 策略（v3：按「地址优先」）：
 *   ① **Geocoder(address)** —— 只要有结构化地址，先按地址定位（用户期望的主策略）。
 *   ② **PlaceSearch(location, city)** —— 地址解析失败时，再按地点名查 POI。
 *   ③ **Geocoder(location)** —— 处理 location 本身就是地址文本的情况。
 *   ④ **PlaceSearch 候选拆词** —— 处理 "奇幻童话城堡与烟花秀"、"北京南站 → 天坛" 等组合词。
 *   ⑤ **Geocoder 候选拆词** —— 最后的兜底。
 *
 * 任何一步成功立即返回；过程中所有错误集中在 lastError 用作最终 fail 描述。
 */
export async function geocodeLocation(
  location: string,
  cityHint?: string,
  address?: string,
): Promise<GeocodeResult> {
  const trimmed = location.trim()
  const trimmedAddr = (address ?? '').trim()
  if (!trimmed && !trimmedAddr) {
    return { status: 'fail', error: '空地名' }
  }
  const key = geocodeKey(trimmed, cityHint, trimmedAddr)
  const cached = geocodeCache[key]
  // ok 永久信任；fail 只在 TTL 内信任，过期后允许重试
  if (cached && cached.status === 'ok') return cached
  if (isFreshFailCache(cached)) return cached

  geocodeCache[key] = { status: 'pending' }

  // 整体兜底超时：无论中间哪一步 hang，最多 25s 一定 resolve
  const result = await withTimeout(
    geocodeLocationInner(trimmed, trimmedAddr, cityHint),
    GEOCODE_TOTAL_TIMEOUT_MS,
    {
      status: 'fail' as const,
      error: '地图响应超时（25s）。可能是网络慢或高德 Key 限流，稍后重试。',
      cachedAt: Date.now(),
    },
  )

  geocodeCache[key] = result.status === 'ok' ? result : { ...result, cachedAt: Date.now() }
  scheduleGeocodeFlush()
  return geocodeCache[key]
}

/**
 * 实际的多策略 geocoding 流程，被 geocodeLocation 套了 withTimeout。
 * 拆出来单独写，让上层只负责"缓存 + 总超时"。
 */
async function geocodeLocationInner(
  trimmed: string,
  trimmedAddr: string,
  cityHint?: string,
): Promise<GeocodeResult> {
  const loaded = await loadAMap()
  if (!loaded.ok) {
    return { status: 'fail', error: loaded.message }
  }

  let lastError = '高德搜不到这个地点'
  const localCityHint = inferCityFromText(trimmedAddr, trimmed, cityHint)

  // ① Geocoder(address)：按用户/LLM 给的结构化地址定位（优先）
  const addressCandidates = buildAddressCandidates(trimmedAddr, localCityHint)
  for (const addr of addressCandidates) {
    const r = await runGeocoder(loaded.AMap, addr, localCityHint)
    if (r.status === 'ok') return r
    lastError = r.error ?? lastError
  }

  // ② PlaceSearch(location, city)：地点名查 POI
  if (trimmed) {
    const r = await runPlaceSearch(loaded.AMap, trimmed, localCityHint)
    if (r.status === 'ok') return r
    lastError = r.error ?? lastError
  }

  // ③ Geocoder(location)：location 本身就是地址的情况
  if (trimmed) {
    const r = await runGeocoder(loaded.AMap, trimmed, localCityHint)
    if (r.status === 'ok') return r
    lastError = r.error ?? lastError
  }

  // ④ PlaceSearch 候选拆词（处理"奇幻童话城堡与烟花秀"等杂质）
  const candidates = buildSearchCandidates(trimmed).filter((c) => c !== trimmed)
  for (const kw of candidates) {
    const r = await runPlaceSearch(loaded.AMap, kw, localCityHint)
    if (r.status === 'ok') return r
    lastError = r.error ?? lastError
  }

  console.warn('[amapService] 地点识别失败', {
    location: trimmed,
    address: trimmedAddr,
    cityHint: localCityHint,
    addressCandidates,
    candidates,
    lastError,
  })

  return { status: 'fail', error: lastError }
}

/**
 * 探索面板专用：按城市 + 类别 翻页搜索 POI。
 *
 * 与 runPlaceSearch 不同：
 * - 这里 citylimit=true（探索时只想看本城市的，跨城反而是噪音）
 * - 一次返回整页 POI（不挑 best），让用户自己浏览
 * - 用关键词 "景点 / 美食 / 酒店" 搭配高德的"类型代码"过滤，结果更准
 *
 * @param category  'attraction' | 'food' | 'hotel'
 * @param city      城市名（如 "北京"），不传走全国搜（不推荐）
 * @param page      1-based 页码
 * @param pageSize  每页大小（高德 v2 上限 25，默认 15）
 */
export interface CityPoi {
  id: string
  name: string
  address: string
  coords: { lng: number; lat: number }
  category: ExploreCategory
  cityname?: string
  /** 高德返回的类型描述（如"风景名胜;公园广场;城市公园"），用于侧栏二级标签 */
  typename?: string
  /** 区县（"东城区"），列表里展示能让用户判断地理位置 */
  district?: string
}

export type ExploreCategory = 'attraction' | 'food' | 'hotel'

/** 三种类别对应的高德搜索关键词与类型代码（typecode 让命中更精准） */
const CITY_POI_QUERIES: Record<ExploreCategory, { keyword: string; type: string }> = {
  attraction: {
    // 风景名胜 + 公园广场（太多代码并列会失败，挑两条主类即可）
    keyword: '景点',
    type: '110000|080300',
  },
  food: {
    // 餐饮服务大类
    keyword: '美食',
    type: '050000',
  },
  hotel: {
    // 商务住宿大类
    keyword: '酒店',
    type: '100000',
  },
}

export interface CityPoiPage {
  items: CityPoi[]
  /** 高德标的命中总数；翻页 UI 用它判断是否还有下一页 */
  total: number
  page: number
  pageSize: number
}

/**
 * 探索面板专用：按"关键词"搜索 POI（用户直接输入地点名 / 模糊词）。
 *
 * 与 searchCityPois 的差别：
 * - 不限 type，让"华东师范大学" / "外滩" / "宽窄巷子" 都能命中
 * - citylimit=false，跨城也搜得到（用户输入精确地点未必跟当前城市一致）
 * - city 作为 hint：传入会让本地结果优先排序，但不会因此漏掉其他城市的同名地点
 *
 * 返回的 ExploreCategory 字段统一标 `attraction` 兜底；UI 只用它做色块。
 *
 * @param keyword   用户输入的关键词；空字符串会抛错
 * @param options.city      可选城市 hint，用于优先排本地命中
 * @param options.page      1-based 页码
 * @param options.pageSize  每页大小（高德 v2 上限 25）
 */
export async function searchAnyPois(
  keyword: string,
  options: {
    city?: string
    page?: number
    pageSize?: number
  } = {},
): Promise<CityPoiPage> {
  const { city = '', page = 1, pageSize = 15 } = options
  const trimmedKw = keyword.trim()
  if (!trimmedKw) throw new Error('请输入要搜索的地点或关键词')

  const loaded = await loadAMap()
  if (!loaded.ok) throw new Error(loaded.message)

  const result = await withTimeout(
    new Promise<{ pois: AMapPoi[]; count: number }>((resolve) => {
      try {
        const search = new loaded.AMap.PlaceSearch({
          // city 作为本地优先 hint；不传走"全国"
          city: city.trim() || '全国',
          // 关键：跨城也允许，让"华东师范大学"在用户当前城市不在上海时也能命中
          citylimit: false,
          pageSize,
          pageIndex: page,
          extensions: 'base',
        })
        search.search(trimmedKw, (status: string, raw) => {
          if (status === 'complete' && raw.poiList?.pois) {
            resolve({
              pois: raw.poiList.pois,
              count: raw.poiList.count ?? raw.poiList.pois.length,
            })
          } else {
            resolve({ pois: [], count: 0 })
          }
        })
      } catch (err) {
        console.error('[amapService] searchAnyPois threw:', err)
        resolve({ pois: [], count: 0 })
      }
    }),
    8000,
    { pois: [], count: 0 },
  )

  /**
   * 关键词搜索的结果可能是混杂类型（餐厅、学校、景点……），
   * 用 typename 粗分一下交给 UI 上色：
   *  - 含"餐饮 / 美食 / 小吃" → food
   *  - 含"住宿 / 酒店 / 旅馆" → hotel
   *  - 其他 → attraction
   */
  function inferCategory(typename?: string): ExploreCategory {
    if (!typename) return 'attraction'
    if (/餐饮|美食|小吃|甜品|咖啡/.test(typename)) return 'food'
    if (/住宿|酒店|旅馆|宾馆|民宿/.test(typename)) return 'hotel'
    return 'attraction'
  }

  const items: CityPoi[] = result.pois
    .filter((p) => p?.name && p?.location && typeof p.location.lng === 'number')
    .map((p) => ({
      id: (p.id as string) || `${p.name}@${p.location.lng},${p.location.lat}`,
      name: p.name,
      address:
        p.address ||
        [p.pname, p.cityname, p.adname].filter(Boolean).join(''),
      coords: { lng: p.location.lng, lat: p.location.lat },
      category: inferCategory(p.type),
      cityname: p.cityname,
      typename: p.type,
      district: p.adname,
    }))

  return {
    items,
    total: result.count,
    page,
    pageSize,
  }
}

export async function searchCityPois(
  category: ExploreCategory,
  city: string,
  page = 1,
  pageSize = 15,
): Promise<CityPoiPage> {
  const loaded = await loadAMap()
  if (!loaded.ok) {
    throw new Error(loaded.message)
  }
  const cfg = CITY_POI_QUERIES[category]
  const trimmedCity = city.trim()
  if (!trimmedCity) {
    throw new Error('请先选择一个城市')
  }
  const result = await withTimeout(
    new Promise<{ pois: AMapPoi[]; count: number }>((resolve) => {
      try {
        const search = new loaded.AMap.PlaceSearch({
          city: trimmedCity,
          // 探索时只看本城市的，跨城列表反而是噪音
          citylimit: true,
          pageSize,
          pageIndex: page,
          extensions: 'base',
          type: cfg.type,
        })
        search.search(cfg.keyword, (status: string, raw) => {
          if (status === 'complete' && raw.poiList?.pois) {
            resolve({
              pois: raw.poiList.pois,
              count: raw.poiList.count ?? raw.poiList.pois.length,
            })
          } else {
            // no_data 也走成功路径返回空，避免 UI 把"这个城市这一页没结果"当报错
            resolve({ pois: [], count: 0 })
          }
        })
      } catch (err) {
        console.error('[amapService] searchCityPois threw:', err)
        resolve({ pois: [], count: 0 })
      }
    }),
    8000,
    { pois: [], count: 0 },
  )

  const items: CityPoi[] = result.pois
    // 必须有坐标和名字；个别返回项偶尔字段缺失
    .filter((p) => p?.name && p?.location && typeof p.location.lng === 'number')
    .map((p) => ({
      id: (p.id as string) || `${p.name}@${p.location.lng},${p.location.lat}`,
      name: p.name,
      address:
        p.address ||
        [p.pname, p.cityname, p.adname].filter(Boolean).join(''),
      coords: { lng: p.location.lng, lat: p.location.lat },
      category,
      cityname: p.cityname,
      typename: p.type,
      district: p.adname,
    }))

  return {
    items,
    total: result.count,
    page,
    pageSize,
  }
}

/**
 * 单次 PlaceSearch（带 SDK 超时）。
 * 不再做内部 retry —— geocodeLocation 上层有 4-5 个候选已经是足够多的"重试"，
 * 内部再 retry 会让单个失败节点变得很慢，反而让用户看到的"卡"更明显。
 */
function runPlaceSearch(
  AMap: AMapNamespace,
  keyword: string,
  city?: string,
): Promise<GeocodeResult> {
  return withTimeout(
    new Promise<GeocodeResult>((resolve) => {
      try {
        const search = new AMap.PlaceSearch({
          city: city ?? '全国',
          // citylimit:false 让跨城市行程不会被卡死；
          // pickBestPoi 会自己挑 city 对的那个 POI
          citylimit: false,
          pageSize: 5,
          extensions: 'base',
        })
        search.search(keyword, (status: string, result) => {
          if (status === 'complete' && result.poiList?.pois?.length) {
            const pois = result.poiList.pois
            const picked = pickBestPoi(pois, city) ?? pois[0]
            resolve({
              status: 'ok',
              coords: {
                lng: picked.location.lng,
                lat: picked.location.lat,
                formattedName: picked.name,
                city: picked.cityname,
              },
            })
          } else {
            resolve({
              status: 'fail',
              error:
                status === 'no_data'
                  ? `PlaceSearch 搜不到「${keyword}」`
                  : `PlaceSearch 返回：${status}`,
            })
          }
        })
      } catch (err) {
        console.error('[amapService] PlaceSearch threw:', err)
        resolve({
          status: 'fail',
          error: err instanceof Error ? err.message : 'PlaceSearch 异常',
        })
      }
    }),
    SDK_CALL_TIMEOUT_MS,
    { status: 'fail', error: `PlaceSearch 超时（${SDK_CALL_TIMEOUT_MS / 1000}s）` },
  )
}

/**
 * 从 PlaceSearch 返回的多个 POI 中挑最合适的：
 *   1. cityname 完全匹配 cityHint（如"上海市"匹配"上海"）→ 优先
 *   2. cityname 包含 cityHint 子串 → 次之
 *   3. 否则取第一个（高德按相关度排序）
 */
function pickBestPoi(
  pois: Array<{
    name: string
    location: { lng: number; lat: number }
    cityname?: string
  }>,
  city?: string,
): typeof pois[number] | undefined {
  if (!city) return pois[0]
  const stripped = city.replace(/[市州县]$/u, '')
  const exact = pois.find(
    (p) => p.cityname && (p.cityname === city || p.cityname.replace(/[市州县]$/u, '') === stripped),
  )
  if (exact) return exact
  const partial = pois.find((p) => p.cityname?.includes(stripped))
  return partial ?? pois[0]
}

/**
 * 单次 Geocoder（带 SDK 超时）。
 * 不再做内部 retry —— buildAddressCandidates 已经产出多个候选给 geocodeLocation 试，
 * 这里再 retry 一遍只会让等待时间翻倍。
 */
function runGeocoder(
  AMap: AMapNamespace,
  address: string,
  city?: string,
): Promise<GeocodeResult> {
  return withTimeout(
    new Promise<GeocodeResult>((resolve) => {
      try {
        // 给 city 提示能显著提升 Geocoder 解析准确度，
        // 否则像"安仁街137号"这种街道名在多个城市都存在时会乱选
        const geocoder = new AMap.Geocoder(city ? { city } : {})
        geocoder.getLocation(address, (status, result) => {
          if (status === 'complete' && result.geocodes?.length) {
            const g = result.geocodes[0]
            const resolvedCity = g.addressComponent?.city
            const formattedAddress = g.formattedAddress ?? ''
            if (!isGeocoderResultReliable(address, formattedAddress, city, resolvedCity)) {
              resolve({
                status: 'fail',
                error: `Geocoder 命中地址与输入不一致：输入「${address}」→ 返回「${formattedAddress}」`,
              })
              return
            }
            // Geocoder 返回的 location 可能是 LngLat 实例（带 getLng/getLat），也可能是 plain object
            const lng = typeof g.location.getLng === 'function' ? g.location.getLng() : g.location.lng
            const lat = typeof g.location.getLat === 'function' ? g.location.getLat() : g.location.lat
            resolve({
              status: 'ok',
              coords: {
                lng,
                lat,
                formattedName: formattedAddress,
                city: resolvedCity,
              },
            })
          } else {
            resolve({
              status: 'fail',
              error:
                status === 'no_data'
                  ? `Geocoder 解析不出「${address}」`
                  : `Geocoder：${status}`,
            })
          }
        })
      } catch (err) {
        console.error('[amapService] Geocoder threw:', err)
        resolve({
          status: 'fail',
          error: err instanceof Error ? err.message : 'Geocoder 异常',
        })
      }
    }),
    SDK_CALL_TIMEOUT_MS,
    { status: 'fail', error: `Geocoder 超时（${SDK_CALL_TIMEOUT_MS / 1000}s）` },
  )
}

/**
 * 批量进度信息（onProgress 回调用）。
 */
export interface GeocodeBatchProgress {
  /** 已完成（成功或失败）的数量 */
  done: number
  /** 总待处理数量（不变） */
  total: number
  /** 正在处理的所有 location（未完成） */
  inFlight: string[]
}

/**
 * 批量地理编码。控制并发避免一次打太多请求触发限流。
 *
 * @param items  待编码的地名 + 可选城市提示
 * @param onItemDone  每个地名完成后的回调（用于增量更新 UI）
 * @param concurrency 并发上限。
 *   高德单 Key Geocoder/PlaceSearch 默认 QPS 50+，并发 4 安全且能让 batch 时间减半。
 * @param onProgress 进度回调，给 UI 显示「3/8 已完成」。
 */
export async function geocodeBatch(
  items: Array<{ location: string; cityHint?: string; address?: string }>,
  onItemDone?: (location: string, result: GeocodeResult) => void,
  concurrency = 4,
  onProgress?: (p: GeocodeBatchProgress) => void,
): Promise<void> {
  const queue = [...items]
  const total = items.length
  const inFlight = new Set<string>()
  let done = 0

  const emitProgress = () => {
    onProgress?.({ done, total, inFlight: [...inFlight] })
  }
  emitProgress()

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      inFlight.add(item.location)
      emitProgress()
      const result = await geocodeLocation(item.location, item.cityHint, item.address)
      inFlight.delete(item.location)
      done += 1
      onItemDone?.(item.location, result)
      emitProgress()
    }
  })
  await Promise.all(workers)
}

export function getCachedGeocode(
  location: string,
  cityHint?: string,
  address?: string,
): GeocodeResult | undefined {
  const v = geocodeCache[geocodeKey(location.trim(), cityHint, address)]
  // 过期 fail 视为无缓存，让上层重新触发 geocodeLocation
  if (v?.status === 'fail' && !isFreshFailCache(v)) return undefined
  return v
}

/**
 * 删除某个地点的 geocode 缓存。
 * 用户主动点"重试识别"时用：清掉旧 fail/pending 让下一次 geocodeLocation 重新走完整流程。
 */
export function clearGeocode(location: string, cityHint?: string, address?: string): void {
  delete geocodeCache[geocodeKey(location.trim(), cityHint, address)]
  scheduleGeocodeFlush()
}

/**
 * 一次性清掉所有 fail / pending 缓存（保留 ok）。
 * 用户点全局"重试识别"按钮时调，比逐个 clearGeocode 更快、更不容易漏。
 */
export function clearAllFailedGeocodes(): number {
  let cleared = 0
  for (const k of Object.keys(geocodeCache)) {
    const v = geocodeCache[k]
    if (v.status !== 'ok') {
      delete geocodeCache[k]
      cleared += 1
    }
  }
  if (cleared) scheduleGeocodeFlush()
  return cleared
}

// ==================== Route Planning ====================
/**
 * 路径规划。先查缓存，命中且未过期直接返。
 *
 * 缓存策略：
 * - ok：缓存 24h（公交时刻表会变化）
 * - unreachable：永久缓存（"步行 100km 不可达"是稳定结论）
 * - fail：**不缓存**。失败往往是网络抖动 / 超时 / 临时故障，
 *   缓存会让用户看到一次"查询失败"再也回不来。
 */
export async function planRoute(
  from: Coords,
  to: Coords,
  mode: TransitMode,
  cityHint?: string,
): Promise<RouteResult> {
  const key = routeKey(from, to, mode)
  const cached = routeCache[key]
  if (cached && cached.status === 'ok') {
    if (!cached.cachedAt || Date.now() - cached.cachedAt < ROUTE_TTL_MS) {
      return cached
    }
  }
  if (cached && cached.status === 'unreachable') {
    return cached
  }

  routeCache[key] = { status: 'pending' }

  const loaded = await loadAMap()
  if (!loaded.ok) {
    // SDK 加载失败也视为 fail，不写 cache（让用户切回页面能重试）
    delete routeCache[key]
    return { status: 'fail', error: loaded.message }
  }

  const result = await runRoutePlan(loaded.AMap, from, to, mode, cityHint)
  if (result.status === 'fail') {
    delete routeCache[key]
  } else {
    routeCache[key] = { ...result, cachedAt: Date.now() }
    scheduleRouteFlush()
  }
  return result
}

function runRoutePlan(
  AMap: AMapNamespace,
  from: Coords,
  to: Coords,
  mode: TransitMode,
  cityHint?: string,
): Promise<RouteResult> {
  // 公交方式必须有 city，否则会瞎查（旧代码硬编码"北京"导致跨城市行程出错）
  if (mode === 'transit') {
    const city = cityHint ?? from.city ?? to.city
    if (!city) {
      return Promise.resolve({
        status: 'fail',
        error: '公交查询需要城市信息，但当前行程未识别出城市',
      })
    }
  }

  return withTimeout(
    new Promise<RouteResult>((resolve) => {
      try {
        const opts: Record<string, unknown> = { hideMarkers: true }
        if (mode === 'transit') {
          opts.city = cityHint ?? from.city ?? to.city
        }
        // taxi 复用 driving 的路径规划（路径相同，只是计费方式不同）
        const Service =
          mode === 'walking' ? AMap.Walking
            : mode === 'driving' || mode === 'taxi' ? AMap.Driving
            : mode === 'transit' ? AMap.Transfer
            : AMap.Riding
        const service = new Service(opts)
        const fromLngLat = new AMap.LngLat(from.lng, from.lat)
        const toLngLat = new AMap.LngLat(to.lng, to.lat)

        service.search(fromLngLat, toLngLat, (status: string, result: RoutingResult) => {
          if (status !== 'complete') {
            resolve({
              status: 'fail',
              error: result?.info ?? `路径规划失败：${status}`,
            })
            return
          }

          // walking/driving/riding 是 routes，transit 是 plans
          const routes = result.routes ?? result.plans ?? []
          if (!routes.length) {
            resolve({ status: 'unreachable', error: '该方式下无可用路线' })
            return
          }
          const best = routes[0]
          resolve({
            status: 'ok',
            distance: best.distance,
            duration: best.time,
          })
        })
      } catch (err) {
        console.error('[amapService] route plan threw:', err)
        resolve({
          status: 'fail',
          error: err instanceof Error ? err.message : '路径规划异常',
        })
      }
    }),
    ROUTE_CALL_TIMEOUT_MS,
    { status: 'fail', error: `路径规划超时（${ROUTE_CALL_TIMEOUT_MS / 1000}s）` },
  )
}

export function getCachedRoute(
  from: Coords | undefined,
  to: Coords | undefined,
  mode: TransitMode,
): RouteResult | undefined {
  if (!from || !to) return undefined
  const cached = routeCache[routeKey(from, to, mode)]
  if (!cached) return undefined
  if (cached.status === 'ok' && cached.cachedAt && Date.now() - cached.cachedAt > ROUTE_TTL_MS) {
    return undefined
  }
  return cached
}

// ==================== 工具：判断 LLM location 与地图返回的城市是否匹配 ====================
/**
 * 给一段 trip_title/summary 文本，提取目标城市；
 * 用于 PlaceSearch 的 city 提示。
 */
export function inferCityFromText(...texts: Array<string | undefined>): string | undefined {
  return extractCity(...texts)
}

// ==================== 格式化 ====================
export function formatDistance(meters: number | undefined): string {
  if (meters === undefined) return '--'
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return '--'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} 分钟`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

// ==================== 费用估算 ====================

export interface FareEstimate {
  /** 估算金额（元，整数） */
  fare: number
  /** 计费明细，用于 hover/title 解释，不打算打车的字段 */
  note: string
}

/**
 * 给定交通方式 + 距离 + 城市，估算该段的费用（人民币元）。
 *
 * 公式参考各城市公开计价标准（2024 年），允许 ±20% 的误差。
 * 不接入打车 API（高德的网约车价格预估 API 仅企业可用），
 * 用本地公式 + 城市分级，**有数比没数好**。
 */
export function estimateFare(
  mode: TransitMode,
  meters: number | undefined,
  city: string | undefined,
): FareEstimate {
  if (meters === undefined || meters <= 0) {
    return { fare: 0, note: '距离未知' }
  }
  const km = meters / 1000

  switch (mode) {
    case 'walking':
      return { fare: 0, note: '步行免费' }

    case 'riding':
      return { fare: 0, note: '自行车/共享单车（共享单车每次约 1.5~3 元）' }

    case 'transit': {
      // 公交/地铁阶梯（按一线城市为例，二三线略低 1-2 元）
      const tier = cityTier(city)
      const adjust = tier === 1 ? 0 : tier === 2 ? -1 : -1
      let fare = 2
      if (km < 6) fare = 3
      else if (km < 12) fare = 4
      else if (km < 22) fare = 5
      else if (km < 32) fare = 6
      else fare = Math.round(6 + (km - 32) * 0.25)
      return {
        fare: Math.max(2, fare + adjust),
        note: `公交/地铁估算（${km.toFixed(1)} km）`,
      }
    }

    case 'driving': {
      // 私家车油费 + 城区停车
      const fuel = km * 0.6
      const parking = km > 0.5 ? (cityTier(city) === 1 ? 15 : 10) : 0
      return {
        fare: Math.round(fuel + parking),
        note: `油费 ¥${Math.round(fuel)}（按 ¥0.6/km） + 停车约 ¥${parking}`,
      }
    }

    case 'taxi': {
      const tier = cityTier(city)
      const startFare = tier === 1 ? 13 : tier === 2 ? 10 : 8
      const startKm = 3
      const perKm = tier === 1 ? 2.6 : tier === 2 ? 2.0 : 1.8
      const base = startFare + Math.max(0, km - startKm) * perKm
      // 简单考虑等待/低速费：长途多 5%
      const fare = Math.round(base * (km > 10 ? 1.05 : 1))
      return {
        fare,
        note:
          `${city ?? '未知城市'}打车估算：起步价 ¥${startFare}/${startKm}km，超出 ¥${perKm}/km。` +
          `\n实际价受时段、拥堵、平台动态加价影响，仅供参考。`,
      }
    }
  }
}
