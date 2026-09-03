import type { CardComment, CardEvent, Project, QnaAnswer, QnaQuestion, RosterUser, Task, Team } from '../types'

export interface RealtimePresenceUser {
  id: string
  githubLogin: string
  displayName: string
  avatarUrl: string | null
}

export interface RealtimeActor {
  id: string
  name: string
}

export type RealtimeEventMap = {
  'connected': { userId: string }
  'presence:update': { onlineUsers: RealtimePresenceUser[] }
  'card:created': { card: Task; actor?: RealtimeActor }
  'card:updated': { card: Task; actor?: RealtimeActor }
  'card:deleted': { id: Task['id']; actor?: RealtimeActor }
  'card:event': CardEvent & { cardId: Task['id']; team?: string }
  'comment:created': { cardId: Task['id']; comment: CardComment; actor?: RealtimeActor }
  'comment:deleted': { cardId: Task['id']; commentId: string; actor?: RealtimeActor }
  'question:created': { question: QnaQuestion; actor?: RealtimeActor }
  'question:deleted': { questionId: string; actor?: RealtimeActor }
  'answer:created': { questionId: string; answer: QnaAnswer; actor?: RealtimeActor }
  'answer:deleted': { questionId: string; answerId: string; actor?: RealtimeActor }
  'teams:updated': { teams: Team[]; projects: Project[]; actor?: RealtimeActor }
  'roster:updated': { user: RosterUser; actor?: RealtimeActor }
  'roster:user_removed': { userId: string; actor?: RealtimeActor }
  'admin:signup_resolved': { userId: string; approved: boolean; actor?: RealtimeActor }
  'checkin:changed': { team?: string; subjectUserId?: string; actor?: RealtimeActor }
  'checkin_goal:changed': { goalId: string; actor?: RealtimeActor }
  'pm_notes:updated': { team: string; notes: Record<string, string>; scratchNotes: string; actor?: RealtimeActor }
}

export type RealtimeEventType = keyof RealtimeEventMap
export type RealtimeEventHandler<K extends RealtimeEventType> = (payload: RealtimeEventMap[K]) => void
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

class RealtimeClient {
  private eventSource: EventSource | null = null
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  private statusListeners = new Set<(status: ConnectionStatus) => void>()
  private status: ConnectionStatus = 'disconnected'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 15000
  private enabled = false

  connect(): void {
    if (this.enabled) return
    this.enabled = true
    this.setupEventSource()
  }

  disconnect(): void {
    this.enabled = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    this.setStatus('disconnected')
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  onStatusChange(fn: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn)
    fn(this.status)
    return () => {
      this.statusListeners.delete(fn)
    }
  }

  subscribe<K extends RealtimeEventType>(event: K, handler: RealtimeEventHandler<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const wrapped = handler as (data: unknown) => void
    set.add(wrapped)

    return () => {
      set.delete(wrapped)
      if (set.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  private setStatus(newStatus: ConnectionStatus) {
    if (this.status === newStatus) return
    this.status = newStatus
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus)
      } catch (e) {
        console.error('Realtime status listener error:', e)
      }
    }
  }

  private setupEventSource() {
    if (typeof window === 'undefined' || !this.enabled) return

    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }

    this.setStatus('connecting')

    try {
      const es = new EventSource('/api/events')
      this.eventSource = es

      es.onopen = () => {
        this.setStatus('connected')
        this.reconnectDelay = 1000
      }

      es.onerror = () => {
        es.close()
        this.eventSource = null
        this.setStatus('disconnected')
        if (this.enabled) {
          this.scheduleReconnect()
        }
      }

      // Register generic handler for all SSE event types
      const allEventNames: RealtimeEventType[] = [
        'connected',
        'presence:update',
        'card:created',
        'card:updated',
        'card:deleted',
        'card:event',
        'comment:created',
        'comment:deleted',
        'question:created',
        'question:deleted',
        'answer:created',
        'answer:deleted',
        'teams:updated',
        'roster:updated',
        'roster:user_removed',
        'admin:signup_resolved',
        'checkin:changed',
        'checkin_goal:changed',
        'pm_notes:updated',
      ]

      for (const eventName of allEventNames) {
        es.addEventListener(eventName, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data)
            this.dispatch(eventName, data)
          } catch (err) {
            console.warn(`Could not parse real-time event [${eventName}]:`, err)
          }
        })
      }
    } catch (err) {
      console.warn('Could not initialize EventSource:', err)
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (!this.enabled || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay)
      this.setupEventSource()
    }, this.reconnectDelay)
  }

  private dispatch(event: string, payload: unknown) {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    for (const fn of handlers) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`Error in real-time handler for [${event}]:`, err)
      }
    }
  }
}

export const realtimeClient = new RealtimeClient()
