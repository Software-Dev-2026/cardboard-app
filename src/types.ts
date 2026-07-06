// Teams are dynamic rows now; a TeamId is a team's slug.
export type TeamId = string
// Board tabs are team slugs; the rest are the fixed views.
export type TabId = string

export interface Team {
  slug: string
  name: string
  archived: boolean
  orderIndex: number
  projectSlug: string | null
}

// A project groups teams — e.g. "Stand-Up" holds the class's stand-up teams,
// and each new set of class projects gets its own named project.
export interface Project {
  slug: string
  name: string
  archived: boolean
  orderIndex: number
}
// Per-team role: a user can be PM of one team and a plain member of another.
export type MemberRole = 'member' | 'pm'

export interface Membership {
  team: TeamId
  role: MemberRole
}
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

export type GoalStatus = 'pending' | 'met' | 'missed'

export interface CheckinGoal {
  id: string
  text: string
  status: GoalStatus
}

export interface Checkin {
  id: string
  team: TeamId
  subjectUserId: string
  subjectName: string
  authorName: string
  checkinDate: string
  notes: string
  createdAt: string
  goals: CheckinGoal[]
}

export interface RosterUser {
  id: string
  displayName: string
  githubLogin: string
  memberships: Membership[]
}
