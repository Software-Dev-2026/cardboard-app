import type { Project, QnaQuestion, RosterUser, Task, Team } from '../types'

export interface CachedBoardData {
  version: number
  cachedAt: number
  tasks: Task[]
  qnaItems: QnaQuestion[]
  roster: RosterUser[]
  teams: Team[]
  projects: Project[]
}

const BOARD_CACHE_KEY = 'cardboard_board_cache_v1'
const PREFS_KEY_PREFIX = 'cardboard_pref_'
const DRAFT_KEY_PREFIX = 'cardboard_draft_'

/**
 * Loads cached board data synchronously from localStorage.
 * Enables 0ms latency first render on page refresh or revisit.
 */
export function loadCachedBoardData(): CachedBoardData | null {
  try {
    const raw = localStorage.getItem(BOARD_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedBoardData
    if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.teams)) {
      return parsed
    }
  } catch (err) {
    console.warn('Failed to parse cached board data:', err)
  }
  return null
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Saves board data to localStorage with debouncing to avoid excessive writes.
 */
export function saveCachedBoardData(data: {
  tasks: Task[]
  qnaItems: QnaQuestion[]
  roster: RosterUser[]
  teams: Team[]
  projects: Project[]
}): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    try {
      const payload: CachedBoardData = {
        version: 1,
        cachedAt: Date.now(),
        tasks: data.tasks,
        qnaItems: data.qnaItems,
        roster: data.roster,
        teams: data.teams,
        projects: data.projects,
      }
      localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(payload))
    } catch (err) {
      console.warn('Failed to save cached board data:', err)
    }
  }, 200)
}

/**
 * Loads a user preference (e.g. active tab, filter settings).
 */
export function loadPreference<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${PREFS_KEY_PREFIX}${key}`)
    if (raw !== null) {
      return JSON.parse(raw) as T
    }
  } catch {
    /* ignore parse errors */
  }
  return fallback
}

/**
 * Persists a user preference.
 */
export function savePreference<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`${PREFS_KEY_PREFIX}${key}`, JSON.stringify(value))
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Saves an unsaved draft (e.g. new card form) so accidental navigation or closing never loses work.
 */
export function saveDraft<T>(key: string, draft: T): void {
  try {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}${key}`, JSON.stringify(draft))
  } catch {
    /* ignore */
  }
}

/**
 * Loads an unsaved draft if present.
 */
export function loadDraft<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${key}`)
    if (raw !== null) {
      return JSON.parse(raw) as T
    }
  } catch {
    /* ignore */
  }
  return fallback
}

/**
 * Clears a draft when committed or cancelled.
 */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(`${DRAFT_KEY_PREFIX}${key}`)
  } catch {
    /* ignore */
  }
}
