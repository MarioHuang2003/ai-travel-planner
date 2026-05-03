/**
 * 高德 JS API 单例加载器。
 *
 * 设计原则：
 * 1. 全局只加载一次：多个组件、多次调用都共享同一个 Promise，避免重复 <script> 注入
 * 2. 没配 Key 时**不抛错**，返回 null + reason，让上层走「友好降级」UI
 * 3. 把 securityJsCode 设置封装在内部，组件不需要关心
 * 4. 失败缓存 30 秒：网络抖动时不会反复重试把页面卡死
 */
import AMapLoader from '@amap/amap-jsapi-loader'

/** 高德 namespace 的最小类型声明（避免引入庞大的 @amap/amap-jsapi-types） */
export interface AMapNamespace {
  Map: new (container: string | HTMLElement, opts?: Record<string, unknown>) => AMapInstance
  Marker: new (opts: Record<string, unknown>) => AMapOverlay
  Polyline: new (opts: Record<string, unknown>) => AMapOverlay
  LngLat: new (lng: number, lat: number) => unknown
  Bounds: new (sw: unknown, ne: unknown) => unknown
  Pixel: new (x: number, y: number) => unknown
  Size: new (w: number, h: number) => unknown
  PlaceSearch: new (opts: Record<string, unknown>) => AMapPlaceSearch
  Geocoder: new (opts?: Record<string, unknown>) => AMapGeocoder
  Walking: new (opts?: Record<string, unknown>) => AMapRoutingService
  Driving: new (opts?: Record<string, unknown>) => AMapRoutingService
  Transfer: new (opts?: Record<string, unknown>) => AMapRoutingService
  Riding: new (opts?: Record<string, unknown>) => AMapRoutingService
}

export interface AMapGeocoder {
  getLocation(
    address: string,
    callback: (status: string, result: GeocoderResult) => void,
  ): void
}

export interface GeocoderResult {
  info: string
  geocodes?: Array<{
    location: { lng: number; lat: number; getLng?: () => number; getLat?: () => number }
    formattedAddress: string
    addressComponent?: { city?: string; province?: string; district?: string }
  }>
}

export interface AMapInstance {
  add(overlay: AMapOverlay | AMapOverlay[]): void
  remove(overlay: AMapOverlay | AMapOverlay[]): void
  setFitView(overlays?: AMapOverlay[] | null, immediately?: boolean, avoid?: number[]): void
  destroy(): void
  setCenter(pos: unknown): void
  setZoom(z: number): void
  on(event: string, handler: (...args: unknown[]) => void): void
}

export interface AMapOverlay {
  setMap?(map: AMapInstance | null): void
  on(event: string, handler: (...args: unknown[]) => void): void
  setAnimation?(name: string): void
  getPosition?(): { lng: number; lat: number; getLng(): number; getLat(): number }
  setExtData?(data: unknown): void
  getExtData?(): unknown
}

/**
 * 高德 PlaceSearch 单条 POI 的最小常用字段。
 * 真实返回还有 tel / pcode / shopinfo / biz_ext 等，这里只声明用得上的，
 * 用 `[k: string]: unknown` 兜底其余字段，避免类型噪音。
 */
export interface AMapPoi {
  id?: string
  name: string
  address: string
  location: { lng: number; lat: number }
  /** 高德标准化的城市名（含"市"），不一定和用户输入完全一致 */
  cityname?: string
  /** 区县名 */
  adname?: string
  /** 类型（中文逗号分隔，如"风景名胜;公园广场;城市公园"） */
  type?: string
  typecode?: string
  pname?: string
  [k: string]: unknown
}

export interface PlaceSearchResult {
  info: string
  poiList?: {
    pois: AMapPoi[]
    /** 总条数（高德返回的命中总数，用于翻页） */
    count?: number
    pageIndex?: number
    pageSize?: number
  }
}

export interface AMapPlaceSearch {
  search(keyword: string, callback: (status: string, result: PlaceSearchResult) => void): void
  setCity(city: string): void
  setPageIndex?(idx: number): void
  setPageSize?(size: number): void
  setType?(type: string): void
}

export interface RoutingResult {
  info: string
  routes?: Array<{ distance: number; time: number }>
  plans?: Array<{ distance: number; time: number }>
}

export interface AMapRoutingService {
  search(
    from: unknown,
    to: unknown,
    callback: (status: string, result: RoutingResult) => void,
  ): void
}

/** 加载结果：成功返回 namespace，失败返回 null + 原因 */
export type LoadResult =
  | { ok: true; AMap: AMapNamespace }
  | { ok: false; reason: 'NO_KEY' | 'LOAD_ERROR'; message: string }

const KEY = import.meta.env.VITE_AMAP_KEY?.trim() ?? ''
const SECURITY_CODE = import.meta.env.VITE_AMAP_SECURITY_CODE?.trim() ?? ''

let loadPromise: Promise<LoadResult> | null = null
let lastFailureAt = 0
const FAIL_RETRY_INTERVAL_MS = 30_000

/** 是否配置了 Key（UI 用此判断要不要显示地图区） */
export function hasAMapKey(): boolean {
  return !!KEY
}

/**
 * 加载高德 JS API（带单例 + 失败短期缓存）。
 *
 * 使用：
 *   const result = await loadAMap()
 *   if (!result.ok) { showFallback(result.message); return }
 *   const map = new result.AMap.Map(...)
 */
export function loadAMap(): Promise<LoadResult> {
  if (!KEY) {
    return Promise.resolve<LoadResult>({
      ok: false,
      reason: 'NO_KEY',
      message: '尚未配置高德地图 Key（VITE_AMAP_KEY）',
    })
  }

  // 失败后短期内别反复重试，避免页面卡顿
  if (loadPromise === null && lastFailureAt > 0) {
    if (Date.now() - lastFailureAt < FAIL_RETRY_INTERVAL_MS) {
      return Promise.resolve<LoadResult>({
        ok: false,
        reason: 'LOAD_ERROR',
        message: '地图加载失败，稍后会自动重试',
      })
    }
  }

  if (loadPromise) return loadPromise

  // 安全密钥必须在 AMapLoader.load 之前配
  if (SECURITY_CODE) {
    ;(window as unknown as { _AMapSecurityConfig?: { securityJsCode: string } })._AMapSecurityConfig = {
      securityJsCode: SECURITY_CODE,
    }
  }

  loadPromise = AMapLoader.load({
    key: KEY,
    version: '2.0',
    plugins: [
      'AMap.PlaceSearch',
      'AMap.Geocoder',
      'AMap.Walking',
      'AMap.Driving',
      'AMap.Transfer',
      'AMap.Riding',
    ],
  })
    .then((AMap: AMapNamespace) => {
      lastFailureAt = 0
      return { ok: true as const, AMap }
    })
    .catch((err: unknown) => {
      console.error('[amapLoader] AMap load failed:', err)
      lastFailureAt = Date.now()
      loadPromise = null
      return {
        ok: false as const,
        reason: 'LOAD_ERROR' as const,
        message: err instanceof Error ? err.message : '地图脚本加载失败',
      }
    })

  return loadPromise
}

// ==================== 城市提取 ====================
// 从 trip_title / summary / location 字符串中尽量识别城市，
// 用于 PlaceSearch 限定范围，提升地理编码命中率
const KNOWN_CITIES = [
  '北京', '上海', '广州', '深圳', '天津', '重庆',
  '成都', '杭州', '苏州', '南京', '武汉', '西安', '长沙', '青岛', '大连',
  '哈尔滨', '昆明', '丽江', '大理', '三亚', '海口', '厦门', '福州', '泉州',
  '南宁', '桂林', '贵阳', '兰州', '银川', '西宁', '乌鲁木齐', '拉萨',
  '济南', '郑州', '太原', '石家庄', '合肥', '南昌',
  '香港', '澳门', '台北', '高雄',
  '宁波', '无锡', '温州', '佛山', '东莞', '珠海', '中山',
] as const

/**
 * 从字符串中提取最先出现的已知城市名。
 * 找不到时返回 undefined（PlaceSearch 会用「全国」范围搜，准确度下降但仍可用）。
 */
export function extractCity(...sources: Array<string | undefined>): string | undefined {
  for (const s of sources) {
    if (!s) continue
    for (const c of KNOWN_CITIES) {
      if (s.includes(c)) return c
    }
  }
  return undefined
}

// ==================== 交通方式定义 ====================
export type TransitMode = 'walking' | 'riding' | 'transit' | 'driving' | 'taxi'

/**
 * 5 种交通方式元数据。
 *   - label：UI 上显示的中文名
 *   - color：跟全局调色板对齐的低饱和度色，用作 chip 边框 / 字色
 *   - softColor：chip 背景（color 的浅色 fill）
 * 不再带 emoji 字段——RouteSegment 内部自带 SVG mono icon。
 */
export const TRANSIT_MODE_META: Record<
  TransitMode,
  { label: string; color: string; softColor: string }
> = {
  walking: { label: '步行', color: '#5d8a6b', softColor: '#e2ebdf' },
  riding: { label: '骑行', color: '#c9874a', softColor: '#f5e4d0' },
  transit: { label: '公交', color: '#557087', softColor: '#dfe6ed' },
  driving: { label: '驾车', color: '#b96256', softColor: '#f3d8d3' },
  taxi: { label: '打车', color: '#8a7aa6', softColor: '#e8e3f0' },
}

/** 给定距离 (km) 判断该方式是否"明显不可达"，避免无意义请求 */
export function isModeReasonable(mode: TransitMode, distanceKm: number): boolean {
  if (mode === 'walking') return distanceKm <= 10
  if (mode === 'riding') return distanceKm <= 30
  return true
}

// ==================== 城市分级（用于打车价估算） ====================
/** 一线 */
const TIER_1 = ['北京', '上海', '广州', '深圳']
/** 新一线 + 主要省会 */
const TIER_2 = [
  '成都', '杭州', '武汉', '西安', '南京', '苏州', '天津', '重庆',
  '青岛', '长沙', '郑州', '宁波', '无锡', '合肥', '佛山', '东莞',
  '昆明', '济南', '福州', '厦门', '大连', '哈尔滨',
]

export type CityTier = 1 | 2 | 3

export function cityTier(city: string | undefined): CityTier {
  if (!city) return 3
  const trimmed = city.replace(/市$/, '').trim()
  if (TIER_1.some((c) => trimmed.includes(c))) return 1
  if (TIER_2.some((c) => trimmed.includes(c))) return 2
  return 3
}

/** 大圆距离粗算 (km)，仅用于上面 isModeReasonable 的判断 */
export function roughDistanceKm(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)))
}
