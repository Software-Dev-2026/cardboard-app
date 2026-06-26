export type TeamId = 'team1' | 'team2'
export type TabId = 'team1' | 'team2' | 'qna' | 'notes'
export type ManagerId = 'manager1' | 'manager2'
export type CardStatus = 'started' | 'flowing' | 'done'

export interface Task {
  id: number | string
  title: string
  description: string
  assignee: string
  dueDate: string
  tags: string[]
  team: TeamId
  cardStatus: CardStatus
}
