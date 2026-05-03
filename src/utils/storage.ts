/**
 * 轻量级类型安全的 localStorage 包装。
 *
 * 设计目标：
 * 1. 隐私模式 / 配额满 / 禁用 storage 时不要直接抛错把 UI 搞挂
 * 2. 把 JSON 序列化/反序列化封装起来，业务方不用自己 try/catch
 * 3. 反序列化失败（比如版本升级数据 schema 变了）时，不要污染应用
 *    → 直接当成"读不到"，让上层走默认值兜底，并清掉脏数据
 */

const PREFIX = 'shuozou-zhouzou:'

function safeKey(key: string): string {
  return `${PREFIX}${key}`
}

function isStorageAvailable(): boolean {
  try {
    const probe = '__probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

const available = typeof window !== 'undefined' && isStorageAvailable()

export function readStorage<T>(key: string, fallback: T): T {
  if (!available) return fallback
  try {
    const raw = window.localStorage.getItem(safeKey(key))
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch (err) {
    console.warn(`[storage] 读取 ${key} 失败，已使用默认值`, err)
    try {
      window.localStorage.removeItem(safeKey(key))
    } catch {
      // ignore
    }
    return fallback
  }
}

export function writeStorage<T>(key: string, value: T): void {
  if (!available) return
  try {
    window.localStorage.setItem(safeKey(key), JSON.stringify(value))
  } catch (err) {
    // 写不进去通常是 quota 满了或被禁用，静默降级即可
    console.warn(`[storage] 写入 ${key} 失败`, err)
  }
}

export function removeStorage(key: string): void {
  if (!available) return
  try {
    window.localStorage.removeItem(safeKey(key))
  } catch {
    // ignore
  }
}
