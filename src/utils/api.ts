import type { CardComment, CardEvent, Checkin, CheckinGoal, GoalStatus, Membership, PendingUser, Project, QnaAnswer, QnaQuestion, RosterUser, Task, Team, TeamActivityEvent, TeamId } from '../types'

type CardPayload = Omit<Task, 'id'> & { id: string }

export interface AuthUser {
  id: string
  githubLogin: string
  displayName: string
  email: string | null
  avatarUrl: string | null
  memberships: Membership[]
  isAdmin: boolean
  approvalStatus: 'pending' | 'approved'
}

interface CardsResponse {
  cards: CardPayload[]
}

interface CardResponse {
  card: CardPayload
}

interface QuestionsResponse {
  questions: QnaQuestion[]
}

interface QuestionResponse {
  question: QnaQuestion
}

interface AnswerResponse {
  answer: QnaAnswer
}

interface MeResponse {
  user: AuthUser | null
  githubConfigured: boolean
}

interface OkResponse {
  ok: boolean
}

interface RosterResponse {
  users: RosterUser[]
}

interface UserResponse {
  user: RosterUser
}

interface CardEventsResponse {
  events: CardEvent[]
}

interface CardCommentsResponse {
  comments: CardComment[]
}

interface CardCommentResponse {
  comment: CardComment
}

interface TeamActivityResponse {
  events: TeamActivityEvent[]
}

export interface PmNotesPayload {
  team?: TeamId
  notes: Record<string, string>
  scratchNotes: string
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

export async function fetchQuestions(): Promise<QnaQuestion[]> {
  const data = await apiRequest<QuestionsResponse>('/api/questions')
  return data.questions
}

export async function createQuestion(question: string): Promise<QnaQuestion> {
  const data = await apiRequest<QuestionResponse>('/api/questions', {
    method: 'POST',
    body: JSON.stringify({ question }),
  })
  return data.question
}

export async function createAnswer(questionId: string, text: string): Promise<QnaAnswer> {
  const data = await apiRequest<AnswerResponse>(`/api/questions/${questionId}/answers`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  return data.answer
}

export async function fetchPmNotes(team: TeamId): Promise<PmNotesPayload> {
  return apiRequest<PmNotesPayload>(`/api/pm-notes?team=${encodeURIComponent(team)}`)
}

export async function savePmNotes(team: TeamId, payload: PmNotesPayload): Promise<PmNotesPayload> {
  return apiRequest<PmNotesPayload>('/api/pm-notes', {
    method: 'PUT',
    body: JSON.stringify({ ...payload, team }),
  })
}

export async function fetchRoster(): Promise<RosterUser[]> {
  const data = await apiRequest<RosterResponse>('/api/roster')
  return data.users
}

export async function fetchAdminUsers(): Promise<RosterUser[]> {
  const data = await apiRequest<RosterResponse>('/api/admin/users')
  return data.users
}

export async function updateUserMemberships(userId: string, memberships: Membership[]): Promise<RosterUser> {
  const data = await apiRequest<UserResponse>(`/api/admin/users/${userId}/memberships`, {
    method: 'PUT',
    body: JSON.stringify({ memberships }),
  })
  return data.user
}

export async function fetchPendingUsers(): Promise<PendingUser[]> {
  const data = await apiRequest<{ users: PendingUser[] }>('/api/admin/pending-users')
  return data.users
}

export async function resolveSignup(userId: string, approve: boolean): Promise<void> {
  await apiRequest<OkResponse>(`/api/admin/users/${userId}/${approve ? 'approve' : 'reject'}`, {
    method: 'POST',
  })
}

export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<RosterUser> {
  const data = await apiRequest<UserResponse>(`/api/admin/users/${userId}/admin`, {
    method: 'PATCH',
    body: JSON.stringify({ isAdmin }),
  })
  return data.user
}

export async function fetchCardEvents(cardId: Task['id']): Promise<CardEvent[]> {
  const data = await apiRequest<CardEventsResponse>(`/api/cards/${cardId}/events`)
  return data.events
}

export async function fetchCardComments(cardId: Task['id']): Promise<CardComment[]> {
  const data = await apiRequest<CardCommentsResponse>(`/api/cards/${cardId}/comments`)
  return data.comments
}

export async function createCardComment(cardId: Task['id'], body: string): Promise<CardComment> {
  const data = await apiRequest<CardCommentResponse>(`/api/cards/${cardId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
  return data.comment
}

export async function fetchTeamActivity(team: TeamId): Promise<TeamActivityEvent[]> {
  const data = await apiRequest<TeamActivityResponse>(`/api/teams/${team}/activity`)
  return data.events
}

export async function createCard(card: Omit<Task, 'id' | 'assignee' | 'createdByUserId'>): Promise<CardPayload> {
  const data = await apiRequest<CardResponse>('/api/cards', {
    method: 'POST',
    body: JSON.stringify(card),
  })
  return data.card
}

export async function deleteCard(id: Task['id']): Promise<void> {
  await apiRequest<OkResponse>(`/api/cards/${id}`, { method: 'DELETE' })
}

export async function updateCard(id: Task['id'], card: Omit<Task, 'id' | 'assignee' | 'createdByUserId'>): Promise<CardPayload> {
  const data = await apiRequest<CardResponse>(`/api/cards/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(card),
  })
  return data.card
}

export interface TeamsAndProjects {
  teams: Team[]
  projects: Project[]
}

interface TeamResponse {
  team: Team
}

interface ProjectResponse {
  project: Project
}

export async function fetchTeams(): Promise<TeamsAndProjects> {
  return apiRequest<TeamsAndProjects>('/api/teams')
}

export async function createTeam(name: string, projectSlug?: string): Promise<Team> {
  const data = await apiRequest<TeamResponse>('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name, projectSlug }),
  })
  return data.team
}

export async function updateTeam(slug: string, patch: { name?: string; archived?: boolean; projectSlug?: string }): Promise<Team> {
  const data = await apiRequest<TeamResponse>(`/api/teams/${slug}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return data.team
}

export async function createProject(name: string): Promise<Project> {
  const data = await apiRequest<ProjectResponse>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return data.project
}

export async function updateProject(slug: string, patch: { name?: string; archived?: boolean }): Promise<Project> {
  const data = await apiRequest<ProjectResponse>(`/api/projects/${slug}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return data.project
}

interface CheckinsResponse {
  checkins: Checkin[]
}

interface CheckinResponse {
  checkin: Checkin
}

interface GoalResponse {
  goal: CheckinGoal
}

export async function fetchTeamCheckins(team: TeamId): Promise<Checkin[]> {
  const data = await apiRequest<CheckinsResponse>(`/api/teams/${team}/checkins`)
  return data.checkins
}

export async function fetchMyCheckins(): Promise<Checkin[]> {
  const data = await apiRequest<CheckinsResponse>('/api/checkins/mine')
  return data.checkins
}

export async function createCheckin(payload: { subjectUserId: string; team: TeamId; notes: string; goals: string[] }): Promise<Checkin> {
  const data = await apiRequest<CheckinResponse>('/api/checkins', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.checkin
}

export async function updateCheckinNotes(checkinId: string, notes: string): Promise<Checkin> {
  const data = await apiRequest<CheckinResponse>(`/api/checkins/${checkinId}`, {
    method: 'PATCH',
    body: JSON.stringify({ notes }),
  })
  return data.checkin
}

export async function updateCheckinGoalStatus(goalId: string, status: GoalStatus): Promise<CheckinGoal> {
  const data = await apiRequest<GoalResponse>(`/api/checkin-goals/${goalId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  return data.goal
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
