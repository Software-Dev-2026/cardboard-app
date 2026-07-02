import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import './App.css'
import {
  createAnswer, createCard, createCardComment, createQuestion, fetchAdminUsers, fetchCardComments,
  fetchCardEvents, fetchCards, fetchMe, fetchPmNotes, fetchQuestions, fetchRoster, fetchTeamActivity, logout,
  savePmNotes, updateCard, updateDefaultName, updateUserRoleTeam,
} from './utils/api'
import type { AuthUser } from './utils/api'
import type {
  CardComment, CardEvent, CardStatus, Priority, QnaQuestion, Role, RosterUser, TabId, Task, TeamActivityEvent, TeamId,
} from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

const PRESET_TAGS = ['Blocked', 'Need Help'] as const

const CARD_STATUSES: Array<{ id: CardStatus; label: string; shortLabel: string }> = [
  { id: 'started', label: 'Not Started', shortLabel: 'Not Started' },
  { id: 'flowing', label: 'In Progress', shortLabel: 'In Progress' },
  { id: 'done',    label: 'Done',        shortLabel: 'Done'        },
]

const PRIORITIES: Array<{ id: Priority; label: string }> = [
  { id: 'high',   label: 'High'   },
  { id: 'medium', label: 'Medium' },
  { id: 'low',    label: 'Low'    },
]

type Theme = 'light' | 'dark'

function getInitialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme')
    if (attr === 'light' || attr === 'dark') return attr
  }
  return 'light'
}

interface EditState {
  title: string
  description: string
  dueDate: string
  presetTags: string[]
  team: TeamId
  cardStatus: CardStatus
  assigneeUserId: string | null
  priority: Priority
}

interface TaskDraft {
  title: string
  description: string
  dueDate: string
  presetTags: string[]
  team: TeamId
  priority: Priority
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TODAY = new Date()

const INITIAL_DRAFT: TaskDraft = {
  title: '',
  description: '',
  dueDate: offsetDate(4),
  presetTags: [],
  team: 'team1',
  priority: 'medium',
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildTags(presetTags: string[]): string[] {
  return [...presetTags]
}

function visibleTags(tags: string[]): string[] {
  return tags.filter((tag) => (PRESET_TAGS as readonly string[]).includes(tag))
}

function taskToEditState(task: Task): EditState {
  const preset = PRESET_TAGS as readonly string[]
  return {
    title: task.title,
    description: task.description,
    dueDate: task.dueDate,
    presetTags: task.tags.filter((t) => preset.includes(t)),
    team: task.team,
    cardStatus: task.cardStatus,
    assigneeUserId: task.assigneeUserId,
    priority: task.priority,
  }
}

function statusLabel(status: string | null): string {
  return CARD_STATUSES.find((s) => s.id === status)?.shortLabel ?? status ?? 'Unknown'
}

function formatEventText(event: CardEvent): string {
  switch (event.eventType) {
    case 'created':
      return `${event.actorName} created this card`
    case 'status_changed':
      return `${event.actorName} moved this from ${statusLabel(event.oldValue)} to ${statusLabel(event.newValue)}`
    case 'assignee_changed':
      return `${event.actorName} reassigned this to ${event.newValue || 'Unassigned'}`
    case 'priority_changed':
      return `${event.actorName} changed priority from ${priorityLabel(event.oldValue)} to ${priorityLabel(event.newValue)}`
    default:
      return `${event.actorName} updated ${event.field ?? 'a field'}`
  }
}

function priorityLabel(priority: string | null): string {
  return PRIORITIES.find((p) => p.id === priority)?.label ?? priority ?? 'Unknown'
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatShortDate(iso.slice(0, 10))
}

// ── TabItem ───────────────────────────────────────────────────────────────────

function TabItem({
  label, active, onClick, onRename,
}: {
  label: string; active: boolean; onClick: () => void; onRename?: (n: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation(); setValue(label); setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }
  function commit() {
    const t = value.trim(); if (t && onRename) onRename(t); setEditing(false)
  }
  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') setEditing(false)
  }

  if (editing) {
    return (
      <div className="tab-btn active tab-btn-editing">
        <input ref={inputRef} className="tab-name-input" value={value}
          onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={handleKey} autoFocus />
      </div>
    )
  }
  return (
    <button className={`tab-btn ${active ? 'active' : ''}`} onClick={onClick}>
      {label}
      {active && onRename && <span className="tab-edit-icon" onClick={startEdit} title="Rename">✎</span>}
    </button>
  )
}

// ── ThemeToggle ───────────────────────────────────────────────────────────────

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      )}
    </button>
  )
}

// ── AccountMenu ───────────────────────────────────────────────────────────────
// Only rendered once a user is signed in — the app-level sign-in wall handles
// the logged-out state, so this component can assume `user` is real.

function AccountMenu({
  user, onLogout, onUserUpdate,
}: {
  user: AuthUser
  onLogout: () => void
  onUserUpdate: (user: AuthUser) => void
}) {
  const [nameValue, setNameValue] = useState(user.displayName)
  const [isSavingName, setIsSavingName] = useState(false)
  const [nameError, setNameError] = useState('')

  async function saveDefaultName() {
    const displayName = nameValue.trim()
    if (!displayName) {
      setNameError('Required')
      return
    }

    setIsSavingName(true)
    setNameError('')
    try {
      const updated = await updateDefaultName(displayName)
      onUserUpdate(updated)
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setIsSavingName(false)
    }
  }

  return (
    <div className="account-menu">
      {user.avatarUrl && <img src={user.avatarUrl} alt="" className="account-avatar" />}
      <div className="account-copy">
        <label className="default-name-field">
          <span>Default name</span>
          <input
            type="text"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={() => { if (nameValue.trim() !== user.displayName) void saveDefaultName() }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setNameValue(user.displayName)
            }}
          />
        </label>
        <span className="account-handle">@{user.githubLogin}</span>
        {nameError && <span className="account-error">{nameError}</span>}
      </div>
      <button
        className="save-name-btn"
        type="button"
        onClick={() => void saveDefaultName()}
        disabled={isSavingName || !nameValue.trim() || nameValue.trim() === user.displayName}
      >
        {isSavingName ? 'Saving' : 'Save'}
      </button>
      <button className="logout-btn" type="button" onClick={onLogout}>Log out</button>
    </div>
  )
}

// ── TagToggleRow ──────────────────────────────────────────────────────────────

function TagToggleRow({ selected, onChange }: { selected: string[]; onChange: (t: string[]) => void }) {
  function toggle(tag: string) {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag])
  }
  return (
    <div className="preset-tag-row">
      {PRESET_TAGS.map((tag) => (
        <button key={tag} type="button"
          className={`preset-tag-btn preset-tag-${tag.toLowerCase().replace(' ', '-')} ${selected.includes(tag) ? 'active' : ''}`}
          onClick={() => toggle(tag)}>
          {tag}
        </button>
      ))}
    </div>
  )
}

// ── StageSelector ─────────────────────────────────────────────────────────────

function StageSelector({ status, onChange }: { status: CardStatus; onChange: (s: CardStatus) => void }) {
  const currentIndex = CARD_STATUSES.findIndex((s) => s.id === status)
  return (
    <div className="stage-selector">
      {CARD_STATUSES.map((stage, i) => (
        <span key={stage.id} className="stage-segment">
          <button
            type="button"
            className={`stage-dot ${i < currentIndex ? 'past' : ''} ${i === currentIndex ? 'current' : ''}`}
            onClick={() => onChange(stage.id)}
            title={`Move to: ${stage.label}`}
          />
          {i < CARD_STATUSES.length - 1 && (
            <span className={`stage-line ${i < currentIndex ? 'filled' : ''}`} />
          )}
        </span>
      ))}
    </div>
  )
}

// ── CardActivity ──────────────────────────────────────────────────────────────

function CardActivity({ cardId }: { cardId: Task['id'] }) {
  const [events, setEvents] = useState<CardEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let isActive = true
    async function load() {
      try {
        const data = await fetchCardEvents(cardId)
        if (isActive) setEvents(data)
      } finally {
        if (isActive) setIsLoading(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [cardId])

  if (isLoading) return <p className="loading-text">Loading activity...</p>
  if (events.length === 0) return <p className="no-answers">No activity yet.</p>

  return (
    <ul className="activity-list">
      {events.map((event) => (
        <li key={event.id} className="activity-item">
          <span className="activity-text">{formatEventText(event)}</span>
          <span className="activity-time">{formatRelativeTime(event.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
}

// ── CardComments ──────────────────────────────────────────────────────────────

function CardComments({ cardId }: { cardId: Task['id'] }) {
  const [comments, setComments] = useState<CardComment[]>([])
  const [draftText, setDraftText] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    let isActive = true
    async function load() {
      try {
        const data = await fetchCardComments(cardId)
        if (isActive) setComments(data)
      } finally {
        if (isActive) setIsLoading(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [cardId])

  async function submitComment() {
    const text = draftText.trim(); if (!text) return
    setIsSubmitting(true)
    try {
      const comment = await createCardComment(cardId, text)
      setComments((cur) => [...cur, comment])
      setDraftText('')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="card-comments">
      {isLoading ? (
        <p className="loading-text">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="no-answers">No comments yet.</p>
      ) : (
        <ul className="answers-list">
          {comments.map((comment) => (
            <li key={comment.id} className="answer-item">
              <span className="qna-a-badge">{comment.authorName.slice(0, 1).toUpperCase()}</span>
              <div className="answer-content">
                <p>{comment.body}</p>
                <span className="answer-author">{comment.authorName} · {formatRelativeTime(comment.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="add-answer-form">
        <textarea className="feedback-textarea" placeholder="Write a comment..." value={draftText} rows={2}
          onChange={(e) => setDraftText(e.target.value)} />
        <div className="answer-form-footer">
          <button className="action-btn-save" onClick={() => void submitComment()} disabled={!draftText.trim() || isSubmitting}>
            {isSubmitting ? 'Posting...' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

function TaskCard({
  task, index, onUpdate, teamNames, roster,
}: {
  task: Task; index: number
  onUpdate: (id: Task['id'], updated: Partial<Task>) => void
  teamNames: Record<TeamId, string>
  roster: RosterUser[]
}) {
  const [editing, setEditing] = useState(false)
  const [editState, setEditState] = useState<EditState>(() => taskToEditState(task))
  const [detailsOpen, setDetailsOpen] = useState(false)

  const dueState = getDueState(task.dueDate)
  const shownTags = visibleTags(task.tags)

  function startEdit() { setEditState(taskToEditState(task)); setEditing(true) }

  function saveEdit() {
    const title = editState.title.trim(); if (!title) return
    onUpdate(task.id, {
      title,
      description: editState.description.trim(),
      assigneeUserId: editState.assigneeUserId,
      dueDate: editState.dueDate,
      tags: buildTags(editState.presetTags),
      team: editState.team,
      cardStatus: editState.cardStatus,
      priority: editState.priority,
    })
    setEditing(false)
  }

  function updateEdit<K extends keyof EditState>(field: K, value: EditState[K]) {
    setEditState((cur) => ({ ...cur, [field]: value }))
  }

  if (editing) {
    return (
      <article className="task-card task-card-editing" style={{ animationDelay: `${index * 50}ms` }}>
        <div className="edit-form">
          <label className="field">
            <span>Title</span>
            <input type="text" value={editState.title} autoFocus
              onChange={(e) => updateEdit('title', e.target.value)} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea value={editState.description} rows={3}
              onChange={(e) => updateEdit('description', e.target.value)} />
          </label>
          <label className="field">
            <span>Due date</span>
            <input type="date" value={editState.dueDate}
              onChange={(e) => updateEdit('dueDate', e.target.value)} />
          </label>
          <label className="field">
            <span>Assignee</span>
            <select value={editState.assigneeUserId ?? ''}
              onChange={(e) => updateEdit('assigneeUserId', e.target.value || null)}>
              <option value="">Unassigned</option>
              {roster.map((person) => (
                <option key={person.id} value={person.id}>{person.displayName}</option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Status tags</span>
            <TagToggleRow selected={editState.presetTags}
              onChange={(tags) => updateEdit('presetTags', tags)} />
          </div>
          <div className="field">
            <span>Section</span>
            <div className="section-radio-row">
              {CARD_STATUSES.map((s) => (
                <label key={s.id} className={`section-radio-option section-radio-${s.id} ${editState.cardStatus === s.id ? 'selected' : ''}`}>
                  <input type="radio" name={`edit-status-${task.id}`}
                    checked={editState.cardStatus === s.id}
                    onChange={() => updateEdit('cardStatus', s.id)} />
                  {s.shortLabel}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Priority</span>
            <div className="section-radio-row">
              {PRIORITIES.map((p) => (
                <label key={p.id} className={`section-radio-option priority-radio-${p.id} ${editState.priority === p.id ? 'selected' : ''}`}>
                  <input type="radio" name={`edit-priority-${task.id}`}
                    checked={editState.priority === p.id}
                    onChange={() => updateEdit('priority', p.id)} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Team</span>
            <div className="team-picker">
              {(['team1', 'team2'] as TeamId[]).map((tid) => (
                <label key={tid} className={`team-option ${editState.team === tid ? 'selected' : ''}`}>
                  <input type="radio" name={`edit-team-${task.id}`}
                    checked={editState.team === tid} onChange={() => updateEdit('team', tid)} />
                  {teamNames[tid]}
                </label>
              ))}
            </div>
          </div>
          <div className="edit-actions">
            <button type="button" className="action-btn-cancel" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="action-btn-save" onClick={saveEdit} disabled={!editState.title.trim()}>Save</button>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className={`task-card card-status-${task.cardStatus}`} style={{ animationDelay: `${index * 50}ms` }}>
      <div className="task-due-row">
        <StageSelector status={task.cardStatus} onChange={(s) => onUpdate(task.id, { cardStatus: s })} />
        <div className="task-due-actions">
          <span className={`priority-badge priority-${task.priority}`}>{priorityLabel(task.priority)}</span>
          <span className={`due-pill due-${dueState.tone}`}>{dueState.label}</span>
          <button className="edit-card-btn" onClick={startEdit}>Edit</button>
        </div>
      </div>

      <h4 className="task-title">{task.title}</h4>
      {task.description && <p className="task-desc">{task.description}</p>}

      {shownTags.length > 0 && (
        <div className="tag-row">
          {shownTags.map((tag) => (
            <span key={tag}
              className={`tag-pill ${tag === 'Blocked' ? 'tag-blocked' : tag === 'Need Help' ? 'tag-need-help' : ''}`}>
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="task-footer">
        <span>{task.assignee}</span>
        <span>{formatShortDate(task.dueDate)}</span>
      </div>

      <button className="feedback-btn" onClick={() => setDetailsOpen((v) => !v)}>
        {detailsOpen ? 'Hide comments & activity' : 'Comments & activity'}
      </button>

      {detailsOpen && (
        <div className="card-details-body">
          <CardActivity cardId={task.id} />
          <CardComments cardId={task.id} />
        </div>
      )}
    </article>
  )
}

// ── SectionColumn ─────────────────────────────────────────────────────────────

function SectionColumn({
  sectionId, label, tasks, onUpdate, teamNames, roster,
}: {
  sectionId: CardStatus; label: string; tasks: Task[]
  onUpdate: (id: Task['id'], updated: Partial<Task>) => void
  teamNames: Record<TeamId, string>
  roster: RosterUser[]
}) {
  return (
    <div className={`section-col section-col-${sectionId}`}>
      <div className="section-col-header">
        <span className={`section-dot section-dot-${sectionId}`} />
        <span className="section-label">{label}</span>
        <span className="section-count">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <p className="section-empty">No cards here yet.</p>
      ) : (
        <div className="section-cards">
          {tasks.map((task, i) => (
            <TaskCard key={task.id} task={task} index={i} onUpdate={onUpdate} teamNames={teamNames} roster={roster} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── QnaCard ───────────────────────────────────────────────────────────────────

function QnaCard({
  item, onAddAnswer, defaultName,
}: {
  item: QnaQuestion
  onAddAnswer: (id: string, text: string) => Promise<void>
  defaultName: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [answerText, setAnswerText] = useState('')

  function submitAnswer() {
    const text = answerText.trim(); if (!text) return
    void onAddAnswer(item.id, text).then(() => setAnswerText(''))
  }

  return (
    <article className="qna-card">
      <button className="qna-header" onClick={() => setExpanded((v) => !v)}>
        <div className="qna-question-wrap">
          <span className="qna-q-badge">Q</span>
          <p className="qna-question">{item.question}</p>
        </div>
        <div className="qna-meta">
          <span className="qna-author">{item.author}</span>
          <span className="answer-count">{item.answers.length} {item.answers.length === 1 ? 'answer' : 'answers'}</span>
          <span className="qna-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <div className="qna-body">
          {item.answers.length > 0 ? (
            <ul className="answers-list">
              {item.answers.map((ans) => (
                <li key={ans.id} className="answer-item">
                  <span className="qna-a-badge">A</span>
                  <div className="answer-content">
                    <p>{ans.text}</p>
                    <span className="answer-author">— {ans.author}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="no-answers">No answers yet — be the first.</p>
          )}
          <div className="add-answer-form">
            <textarea className="feedback-textarea" placeholder="Write an answer..." value={answerText} rows={2}
              onChange={(e) => setAnswerText(e.target.value)} />
            <div className="answer-form-footer">
              <span className="posting-as">Posting as {defaultName}</span>
              <button className="action-btn-save" onClick={submitAnswer} disabled={!answerText.trim()}>Answer</button>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

// ── QnaComposer ───────────────────────────────────────────────────────────────

function QnaComposer({ onPost, defaultName }: { onPost: (question: string) => Promise<void>; defaultName: string }) {
  const [question, setQuestion] = useState('')
  function handleSubmit(e: FormEvent) {
    e.preventDefault(); const q = question.trim(); if (!q) return
    void onPost(q).then(() => setQuestion(''))
  }
  return (
    <form className="composer-form" onSubmit={handleSubmit}>
      <label className="field">
        <span>Your question</span>
        <textarea placeholder="What do you need to know?" value={question} rows={4}
          onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <p className="posting-as">Posting as {defaultName}</p>
      <button className="primary-button" type="submit" disabled={!question.trim()}>Post question</button>
    </form>
  )
}

// ── PmNotes ───────────────────────────────────────────────────────────────────
// A PM only ever sees and edits their own team's notes — team is the PM's own
// `user.team`, never a free choice, closing the hole where the old manager1/
// manager2 toggle let any signed-in user write either manager's notes.

function PmNotes({
  tasks, teamName,
}: {
  tasks: Task[]
  teamName: string
}) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [scratchNotes, setScratchNotes] = useState('')
  const [savedNotesLoaded, setSavedNotesLoaded] = useState(false)
  const scratchRef = useRef<HTMLDivElement>(null)

  function setNote(taskId: string, text: string) {
    setNotes((cur) => ({ ...cur, [taskId]: text }))
  }

  useEffect(() => {
    let isActive = true

    async function loadSavedNotes() {
      try {
        const saved = await fetchPmNotes()
        if (!isActive) return
        setNotes(saved.notes)
        setScratchNotes(saved.scratchNotes)
        setSavedNotesLoaded(true)
      } catch {
        if (isActive) setSavedNotesLoaded(false)
      }
    }

    void loadSavedNotes()
    return () => { isActive = false }
  }, [])

  useEffect(() => {
    if (!savedNotesLoaded) return

    const timeout = window.setTimeout(() => {
      void savePmNotes({ notes, scratchNotes })
    }, 650)

    return () => window.clearTimeout(timeout)
  }, [notes, scratchNotes, savedNotesLoaded])

  function formatScratch(command: 'bold' | 'italic' | 'underline') {
    scratchRef.current?.focus()
    document.execCommand(command)
    setScratchNotes(scratchRef.current?.innerHTML ?? '')
  }

  return (
    <div className="notes-page">
      <div className="notes-header">
        <div><p className="eyebrow">PM View</p><h2 className="notes-title">{teamName} Notes</h2></div>
      </div>
      {tasks.length === 0 ? (
        <p className="loading-text">No cards in {teamName} yet.</p>
      ) : (
        <div className="notes-grid">
          {tasks.map((task) => {
            const dueState = getDueState(task.dueDate)
            const statusInfo = CARD_STATUSES.find((s) => s.id === task.cardStatus)
            const shownTags = visibleTags(task.tags)
            return (
              <div key={task.id} className="note-card">
                <div className="note-card-header">
                  <div className="note-card-meta">
                    <span className={`due-pill due-${dueState.tone}`}>{dueState.label}</span>
                    <span className={`section-status-badge section-status-${task.cardStatus}`}>
                      {statusInfo?.shortLabel}
                    </span>
                    {shownTags.map((tag) => (
                      <span key={tag} className={`tag-pill ${tag === 'Blocked' ? 'tag-blocked' : tag === 'Need Help' ? 'tag-need-help' : ''}`}>{tag}</span>
                    ))}
                  </div>
                  <h4 className="note-card-title">{task.title}</h4>
                  <p className="note-card-sub">{task.assignee} · {formatShortDate(task.dueDate)}</p>
                </div>
                <label className="field note-field">
                  <span>PM notes</span>
                  <textarea className="note-textarea" placeholder="Add observations, blockers, or action items..."
                    value={notes[String(task.id)] ?? ''} rows={4}
                    onChange={(e) => setNote(String(task.id), e.target.value)} />
                </label>
              </div>
            )
          })}
        </div>
      )}
      <section className="scratch-notes">
        <div className="scratch-notes-header">
          <div>
            <h3>Scratchpad</h3>
          </div>
          <div className="format-toolbar" aria-label="Formatting controls">
            <button type="button" title="Bold" onClick={() => formatScratch('bold')}><strong>B</strong></button>
            <button type="button" title="Italic" onClick={() => formatScratch('italic')}><em>I</em></button>
            <button type="button" title="Underline" onClick={() => formatScratch('underline')}><u>U</u></button>
          </div>
        </div>
        <div
          ref={scratchRef}
          className="scratch-editor"
          contentEditable
          role="textbox"
          aria-label={`${teamName} PM scratchpad`}
          data-placeholder="Write general meeting notes, follow-ups, or reminders..."
          dangerouslySetInnerHTML={{ __html: scratchNotes }}
          onInput={(e) => setScratchNotes(e.currentTarget.innerHTML)}
        />
      </section>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({
  team, teamName, tasks, isAdmin, availableTeams, onTeamChange,
}: {
  team: TeamId
  teamName: string
  tasks: Task[]
  isAdmin: boolean
  availableTeams: Array<{ id: TeamId; label: string }>
  onTeamChange: (team: TeamId) => void
}) {
  const [activity, setActivity] = useState<TeamActivityEvent[]>([])
  const [isLoadingActivity, setIsLoadingActivity] = useState(true)

  useEffect(() => {
    let isActive = true
    async function load() {
      try {
        const data = await fetchTeamActivity(team)
        if (isActive) setActivity(data)
      } finally {
        if (isActive) setIsLoadingActivity(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [team])

  const openTasks = tasks.filter((t) => t.cardStatus !== 'done')
  const overdueCount = tasks.filter((t) => getDueState(t.dueDate).tone === 'late').length
  const dueSoonCount = tasks.filter((t) => getDueState(t.dueDate).tone === 'soon').length
  const blockedCount = tasks.filter((t) => t.tags.includes('Blocked')).length
  const needHelpCount = tasks.filter((t) => t.tags.includes('Need Help')).length

  const workload = openTasks.reduce<Record<string, number>>((acc, t) => {
    const name = t.assignee || 'Unassigned'
    acc[name] = (acc[name] ?? 0) + 1
    return acc
  }, {})
  const workloadEntries = Object.entries(workload).sort((a, b) => b[1] - a[1])

  return (
    <div className="notes-page">
      <div className="notes-header">
        <div><p className="eyebrow">PM View</p><h2 className="notes-title">{teamName} Dashboard</h2></div>
        {isAdmin && (
          <div className="manager-toggle">
            {availableTeams.map((t) => (
              <button key={t.id} className={`manager-toggle-btn ${team === t.id ? 'active' : ''}`}
                onClick={() => onTeamChange(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="dashboard-stats-grid">
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-value">{overdueCount}</span>
          <span className="dashboard-stat-label">Overdue</span>
        </div>
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-value">{dueSoonCount}</span>
          <span className="dashboard-stat-label">Due soon</span>
        </div>
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-value">{blockedCount}</span>
          <span className="dashboard-stat-label">Blocked</span>
        </div>
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-value">{needHelpCount}</span>
          <span className="dashboard-stat-label">Need help</span>
        </div>
      </div>

      <section className="scratch-notes">
        <div className="scratch-notes-header"><div><h3>Workload</h3></div></div>
        {workloadEntries.length === 0 ? (
          <p className="no-answers">No open cards.</p>
        ) : (
          <ul className="workload-list">
            {workloadEntries.map(([name, count]) => (
              <li key={name} className="workload-item">
                <span>{name}</span>
                <span className="workload-count">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="scratch-notes">
        <div className="scratch-notes-header"><div><h3>Recent activity</h3></div></div>
        {isLoadingActivity ? (
          <p className="loading-text">Loading activity...</p>
        ) : activity.length === 0 ? (
          <p className="no-answers">No activity yet.</p>
        ) : (
          <ul className="activity-list">
            {activity.map((event) => (
              <li key={event.id} className="activity-item">
                <span className="activity-text">{formatEventText(event)} on "{event.cardTitle}"</span>
                <span className="activity-time">{formatRelativeTime(event.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── AdminPanel ────────────────────────────────────────────────────────────────

function AdminPanel() {
  const [users, setUsers] = useState<RosterUser[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let isActive = true
    async function load() {
      try {
        const data = await fetchAdminUsers()
        if (isActive) setUsers(data)
      } catch (err) {
        if (isActive) setError(err instanceof Error ? err.message : 'Could not load users.')
      } finally {
        if (isActive) setIsLoading(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [])

  async function handleRoleChange(userId: string, role: Role, team: TeamId | null) {
    setError('')
    try {
      const updated = await updateUserRoleTeam(userId, role, team)
      setUsers((cur) => cur.map((u) => (u.id === userId ? updated : u)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update user.')
    }
  }

  return (
    <div className="notes-page">
      <div className="notes-header">
        <div><p className="eyebrow">Admin</p><h2 className="notes-title">Manage roles</h2></div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {isLoading ? (
        <p className="loading-text">Loading users...</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>Name</th><th>GitHub</th><th>Role</th><th>Team</th></tr>
            </thead>
            <tbody>
              {users.map((person) => (
                <tr key={person.id}>
                  <td>{person.displayName}</td>
                  <td>@{person.githubLogin}</td>
                  <td>
                    <select value={person.role}
                      onChange={(e) => void handleRoleChange(person.id, e.target.value as Role, person.team)}>
                      <option value="student">Student</option>
                      <option value="pm">PM</option>
                    </select>
                  </td>
                  <td>
                    <select value={person.team ?? ''}
                      onChange={(e) => void handleRoleChange(person.id, person.role, e.target.value ? (e.target.value as TeamId) : null)}>
                      <option value="">No team</option>
                      <option value="team1">Team 1</option>
                      <option value="team2">Team 2</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [roster, setRoster] = useState<RosterUser[]>([])
  const [draft, setDraft] = useState<TaskDraft>(INITIAL_DRAFT)
  const [teamNames, setTeamNames] = useState<Record<TeamId, string>>({ team1: 'Team 1', team2: 'Team 2' })
  const [activeTab, setActiveTab] = useState<TabId>('team1')
  const [qnaItems, setQnaItems] = useState<QnaQuestion[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [githubConfigured, setGithubConfigured] = useState(true)
  const [authChecked, setAuthChecked] = useState(false)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [myTasksOnly, setMyTasksOnly] = useState(false)
  const [dashboardTeam, setDashboardTeam] = useState<TeamId>('team1')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('cardboard-theme', theme) } catch { /* ignore */ }
  }, [theme])

  useEffect(() => {
    let isActive = true
    async function loadAccount() {
      try {
        const data = await fetchMe()
        if (!isActive) return
        setAuthUser(data.user)
        setGithubConfigured(data.githubConfigured)
      } catch {
        if (isActive) setGithubConfigured(false)
      } finally {
        if (isActive) setAuthChecked(true)
      }
    }
    void loadAccount()
    return () => { isActive = false }
  }, [])

  useEffect(() => {
    if (!authUser) return
    let isActive = true
    async function load() {
      try {
        setIsLoading(true); setError('')
        const [cards, questions, users] = await Promise.all([fetchCards(), fetchQuestions(), fetchRoster()])
        if (isActive) {
          setTasks(cards)
          setQnaItems(questions)
          setRoster(users)
        }
      } catch (err) {
        if (isActive) setError(err instanceof Error ? err.message : 'Could not load cards.')
      } finally {
        if (isActive) setIsLoading(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [authUser])

  const team1Tasks = tasks.filter((t) => t.team === 'team1')
  const team2Tasks = tasks.filter((t) => t.team === 'team2')
  const rawActiveTasks = activeTab === 'team1' ? team1Tasks : team2Tasks
  const activeTasks = myTasksOnly
    ? rawActiveTasks.filter((t) => t.assigneeUserId === authUser?.id)
    : rawActiveTasks
  const defaultName = authUser?.displayName ?? ''

  function updateDraft<K extends keyof TaskDraft>(field: K, value: TaskDraft[K]) {
    setDraft((cur) => ({ ...cur, [field]: value }))
  }

  function selectTab(tab: TabId) {
    setActiveTab(tab)
    if (tab === 'team1' || tab === 'team2') {
      setDraft((cur) => ({ ...cur, team: tab }))
    }
  }

  async function handleCreateTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const title = draft.title.trim(); if (!title) return
    const tags = buildTags(draft.presetTags)

    setIsSaving(true); setError('')
    try {
      const card = await createCard({
        title,
        description: draft.description.trim(),
        assigneeUserId: null,
        dueDate: draft.dueDate,
        tags,
        team: draft.team,
        cardStatus: 'started',
        priority: draft.priority,
      })
      setTasks((cur) => [...cur, card])
      setDraft((cur) => ({ ...INITIAL_DRAFT, dueDate: offsetDate(4), team: cur.team }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create card.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleUpdateTask(id: Task['id'], updated: Partial<Task>) {
    const current = tasks.find((t) => t.id === id)
    if (!current) return
    const merged = { ...current, ...updated }

    try {
      const card = await updateCard(id, {
        title: merged.title,
        description: merged.description,
        assigneeUserId: merged.assigneeUserId,
        dueDate: merged.dueDate,
        tags: merged.tags,
        team: merged.team,
        cardStatus: merged.cardStatus,
        priority: merged.priority,
      })
      setTasks((cur) => cur.map((t) => (t.id === id ? card : t)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update card.')
    }
  }

  async function handleCreateQuestion(question: string) {
    try {
      const created = await createQuestion(question)
      setQnaItems((cur) => [created, ...cur])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post question.')
    }
  }

  async function handleCreateAnswer(questionId: string, text: string) {
    try {
      const answer = await createAnswer(questionId, text)
      setQnaItems((cur) => cur.map((q) => q.id === questionId ? { ...q, answers: [...q.answers, answer] } : q))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post answer.')
    }
  }

  async function handleLogout() {
    await logout()
    setAuthUser(null)
  }

  function handleUserUpdate(user: AuthUser) {
    setAuthUser(user)
  }

  if (!authUser) {
    return (
      <div className="app-shell">
        <div className="signin-wall">
          <h1>Cardboard</h1>
          {!authChecked ? (
            <p className="loading-text">Loading...</p>
          ) : !githubConfigured ? (
            <span className="auth-status">GitHub OAuth not configured</span>
          ) : (
            <>
              <p>Sign in with GitHub to view and manage your team's board.</p>
              <a className="github-login-btn" href="/auth/github/start">Sign in with GitHub</a>
            </>
          )}
        </div>
      </div>
    )
  }

  const canSeeDashboard = authUser.isAdmin || (authUser.role === 'pm' && Boolean(authUser.team))
  const dashboardTeamResolved: TeamId = authUser.isAdmin ? dashboardTeam : (authUser.team ?? 'team1')

  return (
    <div className="app-shell">
      <div className="page-wrapper">
        <div className="top-bar">
          <nav className="tab-bar">
            {(['team1', 'team2'] as TeamId[]).map((tid) => (
              <TabItem key={tid} label={teamNames[tid]} active={activeTab === tid}
                onClick={() => selectTab(tid)}
                onRename={(n) => setTeamNames((cur) => ({ ...cur, [tid]: n }))} />
            ))}
            <TabItem label="Q&A" active={activeTab === 'qna'} onClick={() => selectTab('qna')} />
            {canSeeDashboard && (
              <TabItem label="Dashboard" active={activeTab === 'dashboard'} onClick={() => selectTab('dashboard')} />
            )}
            {authUser.role === 'pm' && authUser.team && (
              <TabItem label="PM Notes" active={activeTab === 'notes'} onClick={() => selectTab('notes')} />
            )}
            {authUser.isAdmin && (
              <TabItem label="Admin" active={activeTab === 'admin'} onClick={() => selectTab('admin')} />
            )}
          </nav>
          <div className="top-bar-actions">
            {(activeTab === 'team1' || activeTab === 'team2') && (
              <button
                type="button"
                className={`tab-btn ${myTasksOnly ? 'active' : ''}`}
                onClick={() => setMyTasksOnly((v) => !v)}
              >
                My Tasks
              </button>
            )}
            <ThemeToggle theme={theme} onToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
            <AccountMenu
              key={authUser.id}
              user={authUser}
              onLogout={() => void handleLogout()}
              onUserUpdate={handleUserUpdate}
            />
          </div>
        </div>

        {activeTab === 'notes' && authUser.role === 'pm' && authUser.team ? (
          <div className="notes-wrapper">
            <PmNotes
              tasks={authUser.team === 'team1' ? team1Tasks : team2Tasks}
              teamName={teamNames[authUser.team]}
            />
          </div>
        ) : activeTab === 'dashboard' && canSeeDashboard ? (
          <div className="notes-wrapper">
            <Dashboard
              key={dashboardTeamResolved}
              team={dashboardTeamResolved}
              teamName={teamNames[dashboardTeamResolved]}
              tasks={dashboardTeamResolved === 'team1' ? team1Tasks : team2Tasks}
              isAdmin={authUser.isAdmin}
              availableTeams={[{ id: 'team1', label: teamNames.team1 }, { id: 'team2', label: teamNames.team2 }]}
              onTeamChange={setDashboardTeam}
            />
          </div>
        ) : activeTab === 'admin' && authUser.isAdmin ? (
          <div className="notes-wrapper">
            <AdminPanel />
          </div>
        ) : (
          <main className="app-layout">
            <aside className="composer-panel">
              {activeTab === 'qna' ? (
                <>
                  <div className="composer-heading"><h2>Ask a question</h2></div>
                  <QnaComposer onPost={handleCreateQuestion} defaultName={defaultName} />
                </>
              ) : (
                <>
                  <div className="composer-heading"><h2>Add card</h2></div>
                  <form className="composer-form" onSubmit={(e) => void handleCreateTask(e)}>
                    <label className="field"><span>Title</span>
                      <input type="text" placeholder="Plan launch office hours" value={draft.title}
                        onChange={(e) => updateDraft('title', e.target.value)} />
                    </label>
                    <label className="field"><span>Description</span>
                      <textarea placeholder="What needs to happen next?" value={draft.description} rows={3}
                        onChange={(e) => updateDraft('description', e.target.value)} />
                    </label>
                    <label className="field"><span>Due date</span>
                      <input type="date" value={draft.dueDate}
                        onChange={(e) => updateDraft('dueDate', e.target.value)} />
                    </label>
                    <div className="field"><span>Priority</span>
                      <div className="section-radio-row">
                        {PRIORITIES.map((p) => (
                          <label key={p.id} className={`section-radio-option priority-radio-${p.id} ${draft.priority === p.id ? 'selected' : ''}`}>
                            <input type="radio" name="draft-priority"
                              checked={draft.priority === p.id}
                              onChange={() => updateDraft('priority', p.id)} />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <p className="posting-as">Card owner: {defaultName}</p>
                    <div className="field"><span>Status tags</span>
                      <TagToggleRow selected={draft.presetTags}
                        onChange={(tags) => updateDraft('presetTags', tags)} />
                    </div>
                    {error && <p className="form-error">{error}</p>}
                    <button className="primary-button" type="submit" disabled={isSaving}>
                      {isSaving ? 'Saving...' : `Add to ${teamNames[draft.team]}`}
                    </button>
                  </form>
                </>
              )}
            </aside>

            <section className="cards-panel">
              {activeTab === 'qna' ? (
                qnaItems.length === 0
                  ? <p className="loading-text">No questions yet — post the first one.</p>
                  : <div className="qna-list">{qnaItems.map((item) => (
                      <QnaCard key={item.id} item={item}
                        defaultName={defaultName}
                        onAddAnswer={handleCreateAnswer} />
                    ))}</div>
              ) : isLoading ? (
                <p className="loading-text">Loading cards...</p>
              ) : (
                <div className="sections-grid">
                  {CARD_STATUSES.map((s) => (
                    <SectionColumn
                      key={s.id}
                      sectionId={s.id}
                      label={s.label}
                      tasks={activeTasks.filter((t) => t.cardStatus === s.id)}
                      onUpdate={handleUpdateTask}
                      teamNames={teamNames}
                      roster={roster}
                    />
                  ))}
                </div>
              )}
            </section>
          </main>
        )}
      </div>
    </div>
  )
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function offsetDate(days: number) {
  const d = new Date(TODAY)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatShortDate(date: string) {
  if (!date) return 'No date'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(`${date}T12:00:00`),
  )
}

function getDueState(date: string): { label: string; tone: 'calm' | 'soon' | 'late' } {
  if (!date) return { label: 'No due date', tone: 'calm' }
  const due = new Date(`${date}T12:00:00`)
  const d = Math.ceil((due.getTime() - TODAY.getTime()) / 86400000)
  if (d < 0)  return { label: `${Math.abs(d)}d late`, tone: 'late' }
  if (d <= 2) return { label: d === 0 ? 'Due today' : `${d}d left`, tone: 'soon' }
  return { label: formatShortDate(date), tone: 'calm' }
}

export default App
