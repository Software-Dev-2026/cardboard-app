import type { Task } from '../types'

type CardPayload = Omit<Task, 'id'> & { id: string }

export interface AuthUser {
  id: string
  githubLogin: string
  displayName: string
  email: string | null
  avatarUrl: string | null
}

interface CardsResponse {
  cards: CardPayload[]
}

interface CardResponse {
  card: CardPayload
}

interface MeResponse {
  user: AuthUser | null
  githubConfigured: boolean
}

interface OkResponse {
  ok: boolean
}

export type ManagerId = 'manager1' | 'manager2'
export type ManagerCardNotes = Record<ManagerId, Record<string, string>>
export type ScratchNotes = Record<ManagerId, string>

export interface ManagerNotesPayload {
  notes: ManagerCardNotes
  scratchNotes: ScratchNotes
}

export async function fetchMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/api/me')
}

export async function updateDefaultName(displayName: string): Promise<AuthUser> {
  const data = await apiRequest<MeResponse>('/api/me', {
    method: 'PUT',
    body: JSON.stringify({ displayName }),
  })
  if (!data.user) throw new Error('Could not update default name.')
  return data.user
}

export async function logout(): Promise<void> {
  await apiRequest<OkResponse>('/api/logout', { method: 'POST' })
}

export async function fetchCards(): Promise<CardPayload[]> {
  const data = await apiRequest<CardsResponse>('/api/cards')
  return data.cards
}

export async function fetchManagerNotes(): Promise<ManagerNotesPayload> {
  return apiRequest<ManagerNotesPayload>('/api/manager-notes')
}

export async function saveManagerNotes(payload: ManagerNotesPayload): Promise<ManagerNotesPayload> {
  return apiRequest<ManagerNotesPayload>('/api/manager-notes', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export async function createCard(card: Omit<Task, 'id'>): Promise<CardPayload> {
  const data = await apiRequest<CardResponse>('/api/cards', {
    method: 'POST',
    body: JSON.stringify(card),
  })
  return data.card
}

export async function updateCard(id: Task['id'], card: Omit<Task, 'id'>): Promise<CardPayload> {
  const data = await apiRequest<CardResponse>(`/api/cards/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(card),
  })
  return data.card
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Request failed.')
  }

  return data as T
}
