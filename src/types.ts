export type TeamId = 'team1' | 'team2'
export type TabId = 'team1' | 'team2' | 'qna' | 'notes' | 'dashboard' | 'admin'
export type Role = 'student' | 'pm'
export type CardStatus = 'started' | 'flowing' | 'done'
export type Priority = 'low' | 'medium' | 'high'

export interface Task {
  id: number | string
  title: string
  description: string
  assignee: string
  assigneeUserId: string | null
  dueDate: string
  tags: string[]
  team: TeamId
  cardStatus: CardStatus
  priority: Priority
}

export interface QnaQuestion {
  id: string
  question: string
  author: string
  answers: QnaAnswer[]
}

export interface QnaAnswer {
  id: string
  text: string
  author: string
}

export interface CardEvent {
  id: string
  eventType: 'created' | 'status_changed' | 'assignee_changed' | 'priority_changed' | 'edited'
  field: string | null
  oldValue: string | null
  newValue: string | null
  createdAt: string
  actorName: string
  actorAvatarUrl: string | null
}

export interface TeamActivityEvent extends CardEvent {
  cardId: string
  cardTitle: string
}

export interface CardComment {
  id: string
  body: string
  createdAt: string
  authorId: string
  authorName: string
  authorAvatarUrl: string | null
}

export interface RosterUser {
  id: string
  displayName: string
  githubLogin: string
  role: Role
  team: TeamId | null
}
