import { Fragment, useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import './App.css'
import {
  createAnswer, createCard, createCardComment, createCheckin, createProject, createQuestion, createTeam,
  deleteCard, fetchAdminUsers, fetchCardComments, fetchCardEvents, fetchCards, fetchMe, fetchMyCheckins,
  fetchPendingUsers, fetchPmNotes, fetchQuestions, fetchRoster, fetchTeamActivity, fetchTeamCheckins, fetchTeams,
  logout, resolveSignup, savePmNotes, setUserAdmin, updateCard, updateCheckinGoalStatus, updateCheckinNotes,
  updateDefaultName, updateProject, updateTeam, updateUserMemberships,
} from './utils/api'
import type { AuthUser } from './utils/api'
import type {
  CardComment, CardEvent, CardStatus, Checkin, GoalStatus, MemberRole, Membership, PendingUser, Priority, Project,
  QnaQuestion, RosterUser, TabId, Task, Team, TeamActivityEvent, TeamId,
} from './types'

// ── Constants ─────────────────────────────────────────────────────────────────

const PRESET_TAGS = ['Blocked', 'Need Help'] as const

const CARD_STATUSES: Array<{ id: CardStatus; label: string; shortLabel: string }> = [
  { id: 'started', label: 'To do',       shortLabel: 'To do'       },
  { id: 'flowing', label: 'In progress', shortLabel: 'In progress' },
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

interface TaskDraft {
  title: string
  description: string
  dueDate: string
  presetTags: string[]
  team: TeamId
  assigneeUserId: string | null
  priority: Priority
}

const TODAY = new Date()

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildTags(presetTags: string[]): string[] {
  return [...presetTags]
}

function visibleTags(tags: string[]): string[] {
  return tags.filter((tag) => (PRESET_TAGS as readonly string[]).includes(tag))
}

function statusLabel(status: string | null): string {
  return CARD_STATUSES.find((s) => s.id === status)?.shortLabel ?? status ?? 'Unknown'
}

function priorityLabel(priority: string | null): string {
  return PRIORITIES.find((p) => p.id === priority)?.label ?? priority ?? 'Unknown'
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

// The team feed names the card inside the sentence ("moved “X” from…") since
// "this" only reads right inside a single card's modal.
function formatTeamEventText(event: TeamActivityEvent): string {
  const card = `“${event.cardTitle}”`
  switch (event.eventType) {
    case 'created':
      return `${event.actorName} created ${card}`
    case 'status_changed':
      return `${event.actorName} moved ${card} from ${statusLabel(event.oldValue)} to ${statusLabel(event.newValue)}`
    case 'assignee_changed':
      return `${event.actorName} reassigned ${card} to ${event.newValue || 'Unassigned'}`
    case 'priority_changed':
      return `${event.actorName} changed ${card} priority from ${priorityLabel(event.oldValue)} to ${priorityLabel(event.newValue)}`
    default:
      return `${event.actorName} updated ${event.field ?? 'a field'} on ${card}`
  }
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

function initialOf(name: string): string {
  return (name.trim().slice(0, 1) || '?').toUpperCase()
}

// ── Wordmark ──────────────────────────────────────────────────────────────────
// The corrugation flutes — the inside of a piece of cardboard — as the mark.

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`wordmark ${compact ? 'wordmark-compact' : ''}`}>
      <svg className="wordmark-flutes" viewBox="0 0 26 18" width="26" height="18" aria-hidden="true">
        <path d="M1 5 Q4.25 1 7.5 5 T14 5 T20.5 5 T27 5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M1 12 Q4.25 8 7.5 12 T14 12 T20.5 12 T27 12" fill="none" stroke="currentColor" strokeWidth="1.8" opacity="0.55" />
      </svg>
      <span className="wordmark-text">Cardboard</span>
    </span>
  )
}

// ── ThemeToggle ───────────────────────────────────────────────────────────────

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onToggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      )}
    </button>
  )
}

// ── Sidebar nav items ─────────────────────────────────────────────────────────

function NavIcon({ kind }: { kind: 'board' | 'qna' | 'dashboard' | 'notes' | 'admin' | 'checkins' | 'review' }) {
  const common = {
    width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none' as const,
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
  switch (kind) {
    case 'board':
      return <svg {...common}><rect x="3" y="3" width="7" height="18" rx="1.5" /><rect x="14" y="3" width="7" height="12" rx="1.5" /></svg>
    case 'qna':
      return <svg {...common}><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
    case 'dashboard':
      return <svg {...common}><path d="M12 20V10M18 20V4M6 20v-4" /></svg>
    case 'notes':
      return <svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
    case 'admin':
      return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
    case 'checkins':
      return <svg {...common}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
    case 'review':
      return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><polyline points="16 11 18 13 22 9" /></svg>
  }
}

function NavItem({
  icon, label, active, onClick, badge,
}: {
  icon: 'board' | 'qna' | 'dashboard' | 'notes' | 'admin' | 'checkins' | 'review'
  label: string
  active: boolean
  onClick: () => void
  badge?: string
}) {
  return (
    <button type="button" className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <NavIcon kind={icon} />
      <span className="nav-item-label">{label}</span>
      {badge !== undefined && <span className="nav-item-badge">{badge}</span>}
    </button>
  )
}

// A team board link that supports renaming its label in place (admins only;
// the rename persists through the team API).
function TeamNavItem({
  label, active, count, onClick, onRename,
}: {
  label: string; active: boolean; count: number; onClick: () => void; onRename?: (n: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)

  function startEdit(e: MouseEvent) {
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
      <div className="nav-item active nav-item-editing">
        <NavIcon kind="board" />
        <input ref={inputRef} className="nav-rename-input" value={value}
          onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={handleKey} autoFocus />
      </div>
    )
  }
  return (
    <button type="button" className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <NavIcon kind="board" />
      <span className="nav-item-label">{label}</span>
      {active && onRename && (
        <span className="nav-rename-icon" onClick={startEdit} title="Rename board" role="button">✎</span>
      )}
      <span className="nav-item-badge">{count}</span>
    </button>
  )
}

// ── SidebarUser ───────────────────────────────────────────────────────────────
// Only rendered once a user is signed in — the app-level sign-in wall handles
// the logged-out state, so this component can assume `user` is real.

function SidebarUser({
  user, teamNames, onLogout, onUserUpdate,
}: {
  user: AuthUser
  teamNames: Record<TeamId, string>
  onLogout: () => void
  onUserUpdate: (user: AuthUser) => void
}) {
  const [open, setOpen] = useState(false)
  const [nameValue, setNameValue] = useState(user.displayName)
  const [isSaving, setIsSaving] = useState(false)
  const [nameError, setNameError] = useState('')

  const pmMemberships = user.memberships.filter((m) => m.role === 'pm')
  const roleChip = user.isAdmin
    ? 'Admin'
    : pmMemberships.length > 0
      ? `PM · ${pmMemberships.map((m) => teamNames[m.team] ?? m.team).join(', ')}`
      : 'Student'

  async function saveDefaultName() {
    const displayName = nameValue.trim()
    if (!displayName) { setNameError('Required'); return }
    setIsSaving(true)
    setNameError('')
    try {
      const updated = await updateDefaultName(displayName)
      onUserUpdate(updated)
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="side-user">
      {open && (
        <div className="side-user-menu">
          <label className="field">
            <span>Display name</span>
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveDefaultName()
                if (e.key === 'Escape') setNameValue(user.displayName)
              }}
            />
          </label>
          {nameError && <p className="form-error">{nameError}</p>}
          <div className="side-user-menu-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void saveDefaultName()}
              disabled={isSaving || !nameValue.trim() || nameValue.trim() === user.displayName}
            >
              {isSaving ? 'Saving…' : 'Save name'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
          </div>
        </div>
      )}
      <button
        type="button"
        className={`side-user-row ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {user.avatarUrl
          ? <img src={user.avatarUrl} alt="" className="avatar avatar-img" />
          : <span className="avatar">{initialOf(user.displayName)}</span>}
        <span className="side-user-copy">
          <span className="side-user-name">{user.displayName}</span>
          <span className="side-user-role">{roleChip}</span>
        </span>
        <span className="side-user-caret" aria-hidden="true">{open ? '▾' : '▴'}</span>
      </button>
    </div>
  )
}

// ── Form bits ─────────────────────────────────────────────────────────────────

function TagToggleRow({ selected, onChange, disabled = false }: { selected: string[]; onChange: (t: string[]) => void; disabled?: boolean }) {
  function toggle(tag: string) {
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag])
  }
  return (
    <div className="tag-toggle-row">
      {PRESET_TAGS.map((tag) => (
        <button key={tag} type="button" disabled={disabled}
          className={`tag-chip tag-${tag.toLowerCase().replace(' ', '-')} ${selected.includes(tag) ? 'active' : ''}`}
          onClick={() => toggle(tag)}>
          {tag}
        </button>
      ))}
    </div>
  )
}

function PriorityPicker({ value, onChange, name, disabled = false }: { value: Priority; onChange: (p: Priority) => void; name: string; disabled?: boolean }) {
  return (
    <div className="segmented">
      {PRIORITIES.map((p) => (
        <label key={p.id} className={`segment priority-segment-${p.id} ${value === p.id ? 'selected' : ''}`}>
          <input type="radio" name={name} checked={value === p.id} disabled={disabled} onChange={() => onChange(p.id)} />
          {p.label}
        </label>
      ))}
    </div>
  )
}

// ── Skeletons ─────────────────────────────────────────────────────────────────
// Ghost placeholders shown while a fetch is in flight, shaped like the content
// they stand in for. The shimmer is killed by the global reduced-motion rule.

function SkeletonLines({ rows = 3 }: { rows?: number }) {
  const widths = ['74%', '58%', '83%', '62%', '77%', '51%']
  return (
    <div className="skel-lines" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skel skel-line" style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="card skel-card">
      <span className="skel skel-line" style={{ width: '34%', height: 9 }} />
      <span className="skel skel-line" style={{ width: '76%' }} />
      <span className="skel skel-line" style={{ width: '92%', height: 9 }} />
      <div className="card-meta">
        <span className="skel skel-dot" />
        <span className="skel skel-line" style={{ width: '40%', height: 9 }} />
      </div>
    </div>
  )
}

function SkeletonBoard() {
  return (
    <div className="board" role="status" aria-label="Loading board">
      {CARD_STATUSES.map((s, col) => (
        <section key={s.id} className="board-col">
          <header className="col-head">
            <span className="skel skel-dot skel-dot-sm" />
            <span className="skel skel-line" style={{ width: 72, height: 9 }} />
          </header>
          <div className="col-cards">
            {Array.from({ length: col === 0 ? 2 : 1 }, (_, i) => <SkeletonCard key={i} />)}
          </div>
        </section>
      ))}
    </div>
  )
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function ModalShell({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  )
}

// ── CardActivity ──────────────────────────────────────────────────────────────

function CardActivity({ cardId, refreshToken }: { cardId: Task['id']; refreshToken: number }) {
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
  }, [cardId, refreshToken])

  if (isLoading) return <SkeletonLines rows={3} />
  if (events.length === 0) return <p className="quiet-text">No activity yet.</p>

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
    <div className="comments-block">
      {isLoading ? (
        <SkeletonLines rows={2} />
      ) : comments.length === 0 ? (
        <p className="quiet-text">No comments yet — start the thread.</p>
      ) : (
        <ul className="comment-list">
          {comments.map((comment) => (
            <li key={comment.id} className="comment-item">
              {comment.authorAvatarUrl
                ? <img src={comment.authorAvatarUrl} alt="" className="avatar avatar-img" />
                : <span className="avatar">{initialOf(comment.authorName)}</span>}
              <div className="comment-body">
                <p className="comment-meta">
                  <span className="comment-author">{comment.authorName}</span>
                  <span className="comment-time">{formatRelativeTime(comment.createdAt)}</span>
                </p>
                <p className="comment-text">{comment.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="comment-composer">
        <textarea placeholder="Write a comment…" value={draftText} rows={2}
          onChange={(e) => setDraftText(e.target.value)} />
        <button type="button" className="btn btn-primary btn-sm"
          onClick={() => void submitComment()} disabled={!draftText.trim() || isSubmitting}>
          {isSubmitting ? 'Posting…' : 'Comment'}
        </button>
      </div>
    </div>
  )
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

function TaskCard({
  task, index, canEdit, onOpen,
}: {
  task: Task; index: number; canEdit: boolean; onOpen: (id: Task['id']) => void
}) {
  const dueState = getDueState(task.dueDate)
  const shownTags = visibleTags(task.tags)

  function handleDragStart(e: DragEvent<HTMLElement>) {
    e.dataTransfer.setData('text/plain', String(task.id))
    e.dataTransfer.effectAllowed = 'move'
  }

  return (
    <article
      className="card"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      draggable={canEdit}
      onDragStart={canEdit ? handleDragStart : undefined}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(task.id) } }}
      role="button"
      tabIndex={0}
    >
      <div className="card-top">
        <span className={`priority-badge priority-${task.priority}`}>{priorityLabel(task.priority)}</span>
        {shownTags.map((tag) => (
          <span key={tag} className={`tag-chip tag-${tag.toLowerCase().replace(' ', '-')} active static`}>{tag}</span>
        ))}
      </div>
      <h3 className="card-title">{task.title}</h3>
      {task.description && <p className="card-desc">{task.description}</p>}
      <div className="card-meta">
        <span className="avatar avatar-sm" title={task.assignee}>{initialOf(task.assignee)}</span>
        <span className="card-assignee">{task.assignee}</span>
        <span className={`due-chip due-${dueState.tone}`}>{dueState.label}</span>
      </div>
    </article>
  )
}

// ── BoardColumn ───────────────────────────────────────────────────────────────

function BoardColumn({
  sectionId, label, tasks, canEditCard, onOpen, onDropCard,
}: {
  sectionId: CardStatus; label: string; tasks: Task[]
  canEditCard: (task: Task) => boolean
  onOpen: (id: Task['id']) => void
  onDropCard: (id: string, status: CardStatus) => void
}) {
  const [isOver, setIsOver] = useState(false)

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault()
    setIsOver(false)
    const id = e.dataTransfer.getData('text/plain')
    if (id) onDropCard(id, sectionId)
  }

  return (
    <section
      className={`board-col ${isOver ? 'drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setIsOver(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setIsOver(false) }}
      onDrop={handleDrop}
    >
      <header className="col-head">
        <span className={`col-dot col-dot-${sectionId}`} />
        <span className="col-name">{label}</span>
        <span className="col-count">{String(tasks.length).padStart(2, '0')}</span>
      </header>
      <div className="col-cards">
        {tasks.length === 0 ? (
          <p className="col-empty">No cards — drag one here</p>
        ) : (
          tasks.map((task, i) => (
            <TaskCard key={task.id} task={task} index={i} canEdit={canEditCard(task)} onOpen={onOpen} />
          ))
        )}
      </div>
    </section>
  )
}

// ── CardDetailModal ───────────────────────────────────────────────────────────
// Property changes commit immediately (like any modern tracker); title and
// description commit on blur so typing isn't a request per keystroke.

function CardDetailModal({
  task, roster, teams, teamNames, canEdit, canDelete, onUpdate, onDelete, onClose,
}: {
  task: Task
  roster: RosterUser[]
  teams: Team[]
  teamNames: Record<TeamId, string>
  canEdit: boolean
  canDelete: boolean
  onUpdate: (id: Task['id'], updated: Partial<Task>) => Promise<void>
  onDelete: (id: Task['id']) => Promise<boolean>
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [refreshToken, setRefreshToken] = useState(0)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleDelete() {
    if (!confirmingDelete) { setConfirmingDelete(true); return }
    setIsDeleting(true)
    const ok = await onDelete(task.id)
    setIsDeleting(false)
    if (ok) onClose()
    else setConfirmingDelete(false)
  }

  function commit(updated: Partial<Task>) {
    void onUpdate(task.id, updated).then(() => setRefreshToken((t) => t + 1))
  }

  function commitTitle() {
    const t = title.trim()
    if (!t) { setTitle(task.title); return }
    if (t !== task.title) commit({ title: t })
  }

  function commitDescription() {
    const d = description.trim()
    if (d !== task.description) commit({ description: d })
  }

  return (
    <ModalShell onClose={onClose} wide>
      <header className="modal-head">
        <span className="modal-eyebrow">{teamNames[task.team] ?? task.team} · {statusLabel(task.cardStatus)}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="card-modal-grid">
        <div className="card-modal-main">
          <input
            className="detail-title"
            value={title}
            readOnly={!canEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            aria-label="Card title"
          />
          <textarea
            className="detail-desc"
            value={description}
            placeholder={canEdit ? 'Add a description…' : 'No description'}
            rows={3}
            readOnly={!canEdit}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            aria-label="Card description"
          />
          <section className="detail-section">
            <h4 className="section-label">Comments</h4>
            <CardComments cardId={task.id} />
          </section>
          <section className="detail-section">
            <h4 className="section-label">Activity</h4>
            <CardActivity cardId={task.id} refreshToken={refreshToken} />
          </section>
        </div>
        <aside className="card-modal-props">
          {!canEdit && (
            <p className="quiet-text">Read-only — only the assignee, the team PM, or an admin can edit this card.</p>
          )}
          <div className="prop">
            <span className="prop-label">Status</span>
            <select value={task.cardStatus} disabled={!canEdit} onChange={(e) => commit({ cardStatus: e.target.value as CardStatus })}>
              {CARD_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">Priority</span>
            <PriorityPicker name={`detail-priority-${task.id}`} value={task.priority} disabled={!canEdit}
              onChange={(p) => commit({ priority: p })} />
          </div>
          <div className="prop">
            <span className="prop-label">Assignee</span>
            <select value={task.assigneeUserId ?? ''} disabled={!canEdit}
              onChange={(e) => commit({ assigneeUserId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {roster.map((person) => (
                <option key={person.id} value={person.id}>{person.displayName}</option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">Due date</span>
            <input type="date" value={task.dueDate} disabled={!canEdit} onChange={(e) => commit({ dueDate: e.target.value })} />
          </div>
          <div className="prop">
            <span className="prop-label">Team</span>
            <select value={task.team} disabled={!canEdit} onChange={(e) => commit({ team: e.target.value as TeamId })}>
              {teams.filter((t) => !t.archived || t.slug === task.team).map((t) => (
                <option key={t.slug} value={t.slug}>{t.name}{t.archived ? ' (archived)' : ''}</option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">Labels</span>
            <TagToggleRow selected={visibleTags(task.tags)} disabled={!canEdit}
              onChange={(tags) => commit({ tags: buildTags(tags) })} />
          </div>
          {canDelete && (
            <div className="prop prop-danger">
              <button
                type="button"
                className={`btn btn-sm ${confirmingDelete ? 'btn-danger' : 'btn-ghost'}`}
                onClick={() => void handleDelete()}
                onBlur={() => setConfirmingDelete(false)}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting…' : confirmingDelete ? 'Really delete? This is permanent' : 'Delete card'}
              </button>
            </div>
          )}
        </aside>
      </div>
    </ModalShell>
  )
}

// ── NewCardModal ──────────────────────────────────────────────────────────────

function NewCardModal({
  defaultTeam, defaultAssigneeId, roster, teams, teamNames, onCreate, onClose,
}: {
  defaultTeam: TeamId
  defaultAssigneeId: string | null
  roster: RosterUser[]
  teams: Team[]
  teamNames: Record<TeamId, string>
  onCreate: (draft: TaskDraft) => Promise<boolean>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<TaskDraft>({
    title: '',
    description: '',
    dueDate: offsetDate(4),
    presetTags: [],
    team: defaultTeam,
    assigneeUserId: defaultAssigneeId,
    priority: 'medium',
  })
  const [isSaving, setIsSaving] = useState(false)

  function update<K extends keyof TaskDraft>(field: K, value: TaskDraft[K]) {
    setDraft((cur) => ({ ...cur, [field]: value }))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!draft.title.trim() || isSaving) return
    setIsSaving(true)
    const ok = await onCreate(draft)
    setIsSaving(false)
    if (ok) onClose()
  }

  return (
    <ModalShell onClose={onClose}>
      <header className="modal-head">
        <span className="modal-eyebrow">New card · {teamNames[draft.team] ?? draft.team}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <form className="new-card-form" onSubmit={(e) => void handleSubmit(e)}>
        <input
          className="detail-title"
          placeholder="Card title"
          value={draft.title}
          onChange={(e) => update('title', e.target.value)}
          autoFocus
        />
        <textarea
          className="detail-desc"
          placeholder="What needs to happen?"
          value={draft.description}
          rows={3}
          onChange={(e) => update('description', e.target.value)}
        />
        <div className="new-card-props">
          <div className="prop">
            <span className="prop-label">Assignee</span>
            <select value={draft.assigneeUserId ?? ''}
              onChange={(e) => update('assigneeUserId', e.target.value || null)}>
              <option value="">Unassigned</option>
              {roster.map((person) => (
                <option key={person.id} value={person.id}>{person.displayName}</option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">Due date</span>
            <input type="date" value={draft.dueDate} onChange={(e) => update('dueDate', e.target.value)} />
          </div>
          <div className="prop">
            <span className="prop-label">Team</span>
            <select value={draft.team} onChange={(e) => update('team', e.target.value as TeamId)}>
              {teams.filter((t) => !t.archived).map((t) => (
                <option key={t.slug} value={t.slug}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">Priority</span>
            <PriorityPicker name="new-card-priority" value={draft.priority}
              onChange={(p) => update('priority', p)} />
          </div>
          <div className="prop">
            <span className="prop-label">Labels</span>
            <TagToggleRow selected={draft.presetTags} onChange={(tags) => update('presetTags', tags)} />
          </div>
        </div>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!draft.title.trim() || isSaving}>
            {isSaving ? 'Creating…' : 'Create card'}
          </button>
        </footer>
      </form>
    </ModalShell>
  )
}

// ── Q&A ───────────────────────────────────────────────────────────────────────

function QnaComposer({ onPost, defaultName }: { onPost: (question: string) => Promise<void>; defaultName: string }) {
  const [question, setQuestion] = useState('')
  function handleSubmit(e: FormEvent) {
    e.preventDefault(); const q = question.trim(); if (!q) return
    void onPost(q).then(() => setQuestion(''))
  }
  return (
    <form className="qna-composer" onSubmit={handleSubmit}>
      <textarea placeholder="What do you need to know?" value={question} rows={2}
        onChange={(e) => setQuestion(e.target.value)} />
      <div className="qna-composer-foot">
        <span className="posting-as">Posting as {defaultName}</span>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!question.trim()}>Post question</button>
      </div>
    </form>
  )
}

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
      <button type="button" className="qna-head" onClick={() => setExpanded((v) => !v)}>
        <span className="avatar avatar-sm">{initialOf(item.author)}</span>
        <span className="qna-question">{item.question}</span>
        <span className="qna-meta">
          <span className="qna-author">{item.author}</span>
          <span className="qna-count">{item.answers.length} {item.answers.length === 1 ? 'answer' : 'answers'}</span>
          <span className="qna-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        </span>
      </button>
      {expanded && (
        <div className="qna-body">
          {item.answers.length > 0 ? (
            <ul className="comment-list">
              {item.answers.map((ans) => (
                <li key={ans.id} className="comment-item">
                  <span className="avatar">{initialOf(ans.author)}</span>
                  <div className="comment-body">
                    <p className="comment-meta"><span className="comment-author">{ans.author}</span></p>
                    <p className="comment-text">{ans.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet-text">No answers yet — be the first.</p>
          )}
          <div className="comment-composer">
            <textarea placeholder="Write an answer…" value={answerText} rows={2}
              onChange={(e) => setAnswerText(e.target.value)} />
            <button type="button" className="btn btn-primary btn-sm" onClick={submitAnswer} disabled={!answerText.trim()}>
              Answer
            </button>
          </div>
          <p className="posting-as">Posting as {defaultName}</p>
        </div>
      )}
    </article>
  )
}

// ── PmNotes ───────────────────────────────────────────────────────────────────
// The team must be one the viewer holds the PM role on — the server rejects
// anything else, and multi-team PMs switch teams via the view-bar toggle.

function PmNotes({
  team, tasks, teamName,
}: {
  team: TeamId
  tasks: Task[]
  teamName: string
}) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [scratchNotes, setScratchNotes] = useState('')
  const [savedNotesLoaded, setSavedNotesLoaded] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [selectedId, setSelectedId] = useState<string>('scratchpad')
  const scratchRef = useRef<HTMLDivElement>(null)

  const selectedTask = tasks.find((t) => String(t.id) === selectedId) ?? null

  function setNote(taskId: string, text: string) {
    setNotes((cur) => ({ ...cur, [taskId]: text }))
  }

  useEffect(() => {
    let isActive = true
    async function loadSavedNotes() {
      try {
        const saved = await fetchPmNotes(team)
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
  }, [team])

  // The scratchpad div is uncontrolled while typing (React never rewrites its
  // HTML, so the caret stays put). Seed its content only when the view opens
  // or the saved notes arrive.
  useEffect(() => {
    if (selectedId !== 'scratchpad' || !scratchRef.current) return
    if (scratchRef.current.innerHTML !== scratchNotes) {
      scratchRef.current.innerHTML = scratchNotes
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, savedNotesLoaded])

  useEffect(() => {
    if (!savedNotesLoaded) return
    const timeout = window.setTimeout(() => {
      setSaveState('saving')
      savePmNotes(team, { notes, scratchNotes })
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('idle'))
    }, 650)
    return () => window.clearTimeout(timeout)
  }, [team, notes, scratchNotes, savedNotesLoaded])

  function formatScratch(command: 'bold' | 'italic' | 'underline') {
    scratchRef.current?.focus()
    document.execCommand(command)
    setScratchNotes(scratchRef.current?.innerHTML ?? '')
  }

  const grouped = CARD_STATUSES.map((s) => ({
    ...s,
    items: tasks.filter((t) => t.cardStatus === s.id),
  }))

  return (
    <div className="pm-notes-layout">
      <aside className="pm-list panel">
        <button
          type="button"
          className={`pm-row pm-row-scratch ${selectedId === 'scratchpad' ? 'active' : ''}`}
          onClick={() => setSelectedId('scratchpad')}
        >
          <span className="pm-row-title">Scratchpad</span>
          <span className="pm-row-sub">{teamName} · general notes</span>
        </button>
        {tasks.length === 0 ? (
          <p className="quiet-text">No cards in {teamName} yet.</p>
        ) : (
          grouped.map((group) => group.items.length > 0 && (
            <div key={group.id} className="pm-group">
              <p className="pm-group-label">
                <span className={`col-dot col-dot-${group.id}`} />
                {group.label}
                <span className="col-count">{String(group.items.length).padStart(2, '0')}</span>
              </p>
              {group.items.map((task) => {
                const hasNote = Boolean(notes[String(task.id)]?.trim())
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={`pm-row ${selectedId === String(task.id) ? 'active' : ''}`}
                    onClick={() => setSelectedId(String(task.id))}
                  >
                    <span className="pm-row-title">
                      {task.title}
                      {hasNote && <span className="pm-note-dot" title="Has a note" />}
                    </span>
                    <span className="pm-row-sub">{task.assignee}</span>
                  </button>
                )
              })}
            </div>
          ))
        )}
      </aside>

      <section className="pm-editor panel">
        <div className="panel-head">
          {selectedTask ? (
            <div className="pm-editor-heading">
              <h3 className="panel-title">{selectedTask.title}</h3>
              <div className="note-card-chips">
                <span className={`status-chip status-${selectedTask.cardStatus}`}>{statusLabel(selectedTask.cardStatus)}</span>
                <span className={`priority-badge priority-${selectedTask.priority}`}>{priorityLabel(selectedTask.priority)}</span>
                <span className={`due-chip due-${getDueState(selectedTask.dueDate).tone}`}>{getDueState(selectedTask.dueDate).label}</span>
                {visibleTags(selectedTask.tags).map((tag) => (
                  <span key={tag} className={`tag-chip tag-${tag.toLowerCase().replace(' ', '-')} active static`}>{tag}</span>
                ))}
              </div>
              <p className="note-card-sub">{selectedTask.assignee} · due {formatShortDate(selectedTask.dueDate)}</p>
            </div>
          ) : (
            <div className="pm-editor-heading">
              <h3 className="panel-title">Scratchpad</h3>
              <p className="note-card-sub">{teamName} · meeting notes, follow-ups, reminders</p>
            </div>
          )}
          <div className="pm-editor-tools">
            {!selectedTask && (
              <div className="format-toolbar" aria-label="Formatting controls">
                <button type="button" title="Bold" onClick={() => formatScratch('bold')}><strong>B</strong></button>
                <button type="button" title="Italic" onClick={() => formatScratch('italic')}><em>I</em></button>
                <button type="button" title="Underline" onClick={() => formatScratch('underline')}><u>U</u></button>
              </div>
            )}
            <span className={`save-state save-state-${saveState}`}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}
            </span>
          </div>
        </div>

        {selectedTask ? (
          <textarea
            key={String(selectedTask.id)}
            className="note-textarea pm-note-editor"
            placeholder="Observations, blockers, action items…"
            value={notes[String(selectedTask.id)] ?? ''}
            onChange={(e) => setNote(String(selectedTask.id), e.target.value)}
          />
        ) : (
          <div
            ref={scratchRef}
            className="scratch-editor"
            contentEditable
            role="textbox"
            aria-label={`${teamName} PM scratchpad`}
            data-placeholder="Meeting notes, follow-ups, reminders…"
            onInput={(e) => setScratchNotes(e.currentTarget.innerHTML)}
          />
        )}
      </section>
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({
  team, teamName, tasks,
}: {
  team: TeamId
  teamName: string
  tasks: Task[]
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

  // All four tiles count open cards only — a card that's Done can't be
  // overdue or blocked anymore.
  const openTasks = tasks.filter((t) => t.cardStatus !== 'done')
  const overdueCount = openTasks.filter((t) => getDueState(t.dueDate).tone === 'late').length
  const dueSoonCount = openTasks.filter((t) => getDueState(t.dueDate).tone === 'soon').length
  const blockedCount = openTasks.filter((t) => t.tags.includes('Blocked')).length
  const needHelpCount = openTasks.filter((t) => t.tags.includes('Need Help')).length

  const workload = openTasks.reduce<Record<string, number>>((acc, t) => {
    const name = t.assignee || 'Unassigned'
    acc[name] = (acc[name] ?? 0) + 1
    return acc
  }, {})
  const workloadEntries = Object.entries(workload).sort((a, b) => b[1] - a[1])
  // Each bar is that person's share of the team's open cards, so a full bar
  // always means "all of the open work" and imbalance is readable at a glance.
  const totalOpen = Math.max(1, openTasks.length)

  const stats: Array<{ label: string; value: number; tone: 'red' | 'amber' | 'gray' }> = [
    { label: 'Overdue', value: overdueCount, tone: 'red' },
    { label: 'Due soon', value: dueSoonCount, tone: 'amber' },
    { label: 'Blocked', value: blockedCount, tone: 'red' },
    { label: 'Need help', value: needHelpCount, tone: 'amber' },
  ]

  return (
    <div className="page">
      <div className="stat-grid">
        {stats.map((s) => (
          <div key={s.label} className={`stat-tile ${s.value > 0 ? `stat-${s.tone}` : ''}`}>
            <span className="stat-value">{String(s.value).padStart(2, '0')}</span>
            <span className="stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head"><h3 className="panel-title">Workload</h3><span className="panel-note">share of the team's open cards</span></div>
        {workloadEntries.length === 0 ? (
          <p className="quiet-text">No open cards in {teamName}.</p>
        ) : (
          <ul className="workload-list">
            {workloadEntries.map(([name, count]) => (
              <li key={name} className="workload-item">
                <span className="workload-name">{name}</span>
                <span className="workload-bar-track">
                  <span className="workload-bar" style={{ width: `${(count / totalOpen) * 100}%` }} />
                </span>
                <span className="workload-count">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h3 className="panel-title">Recent activity</h3></div>
        {isLoadingActivity ? (
          <SkeletonLines rows={5} />
        ) : activity.length === 0 ? (
          <p className="quiet-text">No activity yet.</p>
        ) : (
          <ul className="activity-list">
            {activity.map((event) => (
              <li key={event.id} className="activity-item">
                <span className="activity-text">{formatTeamEventText(event)}</span>
                <span className="activity-time">{formatRelativeTime(event.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── Check-ins ─────────────────────────────────────────────────────────────────
// A PM's dated 1:1 notes + goals per student. PM/admin write; the student can
// read their own entries. Last check-in's goals get resolved (met/missed) at
// the next one — that's the accountability loop.

const GOAL_STATUSES: Array<{ id: GoalStatus; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'met',     label: 'Met'     },
  { id: 'missed',  label: 'Missed'  },
]

function GoalRow({
  goal, canEdit, onSetStatus,
}: {
  goal: { id: string; text: string; status: GoalStatus }
  canEdit: boolean
  onSetStatus?: (goalId: string, status: GoalStatus) => void
}) {
  return (
    <li className={`goal-row goal-${goal.status}`}>
      <span className="goal-text">{goal.text}</span>
      {canEdit && onSetStatus ? (
        <div className="segmented segmented-mini">
          {GOAL_STATUSES.map((s) => (
            <label key={s.id} className={`segment goal-segment-${s.id} ${goal.status === s.id ? 'selected' : ''}`}>
              <input type="radio" name={`goal-${goal.id}`} checked={goal.status === s.id}
                onChange={() => onSetStatus(goal.id, s.id)} />
              {s.label}
            </label>
          ))}
        </div>
      ) : (
        <span className={`goal-status-chip goal-chip-${goal.status}`}>
          {GOAL_STATUSES.find((s) => s.id === goal.status)?.label}
        </span>
      )}
    </li>
  )
}

function CheckinEntry({
  entry, isLatest, canEdit, showSubject, onSetGoalStatus, onSaveNotes,
}: {
  entry: Checkin
  isLatest: boolean
  canEdit: boolean
  showSubject?: boolean
  onSetGoalStatus?: (goalId: string, status: GoalStatus) => void
  onSaveNotes?: (checkinId: string, notes: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [notesDraft, setNotesDraft] = useState(entry.notes)
  const pendingCount = entry.goals.filter((g) => g.status === 'pending').length

  async function saveNotes() {
    if (!onSaveNotes) return
    const ok = await onSaveNotes(entry.id, notesDraft.trim())
    if (ok) setEditing(false)
  }

  return (
    <article className={`panel checkin-entry ${isLatest ? 'checkin-latest' : ''}`}>
      <header className="checkin-entry-head">
        <span className="checkin-date">{formatShortDate(entry.checkinDate)}</span>
        <span className="checkin-byline">
          {showSubject ? `${entry.subjectName} · ` : ''}by {entry.authorName}
        </span>
        {isLatest && (
          <span className="checkin-latest-chip">
            Last check-in{canEdit && pendingCount > 0 ? ` · ${pendingCount} to resolve` : ''}
          </span>
        )}
        {canEdit && onSaveNotes && !editing && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setNotesDraft(entry.notes); setEditing(true) }}>
            Edit
          </button>
        )}
      </header>
      {editing ? (
        <div className="checkin-notes-edit">
          <textarea value={notesDraft} rows={3} onChange={(e) => setNotesDraft(e.target.value)} />
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveNotes()}>Save notes</button>
          </div>
        </div>
      ) : (
        entry.notes && <p className="checkin-notes">{entry.notes}</p>
      )}
      {entry.goals.length > 0 && (
        <div className="checkin-goals">
          <p className="prop-label">Goals for next check-in</p>
          <ul className="goal-list">
            {entry.goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} canEdit={canEdit} onSetStatus={onSetGoalStatus} />
            ))}
          </ul>
        </div>
      )}
    </article>
  )
}

function CheckinComposer({
  subjectName, onCreate,
}: {
  subjectName: string
  onCreate: (notes: string, goals: string[]) => Promise<boolean>
}) {
  const [notes, setNotes] = useState('')
  const [goals, setGoals] = useState<string[]>([])
  const [goalInput, setGoalInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  function addGoal() {
    const g = goalInput.trim(); if (!g) return
    setGoals((cur) => [...cur, g])
    setGoalInput('')
  }

  const pendingGoal = goalInput.trim()
  const allGoals = pendingGoal ? [...goals, pendingGoal] : goals
  const canSave = Boolean(notes.trim() || allGoals.length > 0)

  async function save() {
    if (!canSave || isSaving) return
    setIsSaving(true)
    const ok = await onCreate(notes.trim(), allGoals)
    setIsSaving(false)
    if (ok) { setNotes(''); setGoals([]); setGoalInput('') }
  }

  return (
    <section className="panel checkin-composer">
      <div className="panel-head">
        <h3 className="panel-title">New check-in</h3>
        <span className="panel-note">{subjectName}</span>
      </div>
      <textarea
        className="note-textarea"
        placeholder="How is it going? Blockers, progress, observations…"
        value={notes}
        rows={3}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="checkin-goal-builder">
        <p className="prop-label">Goals for next check-in</p>
        {goals.length > 0 && (
          <ul className="goal-list">
            {goals.map((g, i) => (
              <li key={`${g}-${i}`} className="goal-row goal-pending">
                <span className="goal-text">{g}</span>
                <button type="button" className="icon-btn" aria-label={`Remove goal: ${g}`}
                  onClick={() => setGoals((cur) => cur.filter((_, idx) => idx !== i))}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <div className="goal-input-row">
          <input
            type="text"
            placeholder="Add a goal…"
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGoal() } }}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={addGoal} disabled={!goalInput.trim()}>Add</button>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!canSave || isSaving}>
          {isSaving ? 'Saving…' : 'Save check-in'}
        </button>
      </div>
    </section>
  )
}

function TeamCheckins({
  team, teamName, roster, tasks,
}: {
  team: TeamId
  teamName: string
  roster: RosterUser[]
  tasks: Task[]
}) {
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState('')

  const students = roster.filter((u) => u.memberships.some((m) => m.team === team))
  const selected = students.find((s) => s.id === selectedId) ?? students[0] ?? null

  useEffect(() => {
    let isActive = true
    async function load() {
      try {
        setIsLoading(true); setError('')
        const data = await fetchTeamCheckins(team)
        if (isActive) setCheckins(data)
      } catch (err) {
        if (isActive) setError(err instanceof Error ? err.message : 'Could not load check-ins.')
      } finally {
        if (isActive) setIsLoading(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [team])

  const entries = selected ? checkins.filter((c) => c.subjectUserId === selected.id) : []
  const openCards = selected ? tasks.filter((t) => t.assigneeUserId === selected.id && t.cardStatus !== 'done') : []

  function lastCheckinDate(studentId: string): string | null {
    const entry = checkins.find((c) => c.subjectUserId === studentId)
    return entry ? entry.checkinDate : null
  }

  async function handleCreate(notes: string, goals: string[]): Promise<boolean> {
    if (!selected) return false
    setError('')
    try {
      const created = await createCheckin({ subjectUserId: selected.id, team, notes, goals })
      setCheckins((cur) => [created, ...cur])
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save check-in.')
      return false
    }
  }

  function handleSetGoalStatus(goalId: string, status: GoalStatus) {
    setError('')
    void updateCheckinGoalStatus(goalId, status)
      .then((updated) => {
        setCheckins((cur) => cur.map((c) => ({
          ...c,
          goals: c.goals.map((g) => (g.id === updated.id ? updated : g)),
        })))
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not update goal.'))
  }

  async function handleSaveNotes(checkinId: string, notes: string): Promise<boolean> {
    setError('')
    try {
      const updated = await updateCheckinNotes(checkinId, notes)
      setCheckins((cur) => cur.map((c) => (c.id === updated.id ? updated : c)))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save notes.')
      return false
    }
  }

  if (students.length === 0) {
    return <p className="quiet-text page">No students on {teamName} yet — assign roles and teams from the Admin tab.</p>
  }

  return (
    <div className="pm-notes-layout">
      <aside className="pm-list panel">
        <p className="pm-group-label">{teamName} members</p>
        {students.map((student) => {
          const last = lastCheckinDate(student.id)
          return (
            <button
              key={student.id}
              type="button"
              className={`pm-row ${selected?.id === student.id ? 'active' : ''}`}
              onClick={() => setSelectedId(student.id)}
            >
              <span className="pm-row-title">{student.displayName}</span>
              <span className="pm-row-sub">{last ? `Last check-in ${formatShortDate(last)}` : 'No check-ins yet'}</span>
            </button>
          )
        })}
      </aside>

      <div className="checkin-main">
        {error && <p className="error-banner">{error}</p>}
        {selected && (
          <>
            {openCards.length > 0 && (
              <div className="checkin-context">
                <span className="prop-label">Open cards</span>
                {openCards.map((t) => (
                  <span key={t.id} className="checkin-card-chip">
                    <span className={`col-dot col-dot-${t.cardStatus}`} />
                    {t.title}
                  </span>
                ))}
              </div>
            )}
            <CheckinComposer key={selected.id} subjectName={selected.displayName} onCreate={handleCreate} />
            {isLoading ? (
              <div className="panel"><SkeletonLines rows={3} /></div>
            ) : entries.length === 0 ? (
              <p className="quiet-text">No check-ins for {selected.displayName} yet — the first one starts the record.</p>
            ) : (
              entries.map((entry, i) => (
                <CheckinEntry
                  key={entry.id}
                  entry={entry}
                  isLatest={i === 0}
                  canEdit
                  onSetGoalStatus={handleSetGoalStatus}
                  onSaveNotes={handleSaveNotes}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}

function MyCheckins() {
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let isActive = true
    async function load() {
      try {
        const data = await fetchMyCheckins()
        if (isActive) setCheckins(data)
      } finally {
        if (isActive) setIsLoading(false)
      }
    }
    void load()
    return () => { isActive = false }
  }, [])

  return (
    <div className="page checkin-mine">
      {isLoading ? (
        <div className="panel"><SkeletonLines rows={4} /></div>
      ) : checkins.length === 0 ? (
        <p className="quiet-text">No check-ins yet — your PM will log notes and goals for you here after your next 1:1.</p>
      ) : (
        checkins.map((entry, i) => (
          <CheckinEntry key={entry.id} entry={entry} isLatest={i === 0} canEdit={false} />
        ))
      )}
    </div>
  )
}

// ── Pending approval ──────────────────────────────────────────────────────────
// New sign-ins wait here until an admin approves them from Review students.
// The poll notices both outcomes: approval opens the app; rejection deletes
// the account server-side, so /api/me returns no user and the sign-in wall
// comes back for another try.

function PendingApprovalScreen({
  user, onStatusChange, onLogout,
}: {
  user: AuthUser
  onStatusChange: (user: AuthUser | null) => void
  onLogout: () => void
}) {
  useEffect(() => {
    const id = window.setInterval(() => {
      fetchMe()
        .then((data) => {
          if (!data.user || data.user.approvalStatus === 'approved') onStatusChange(data.user)
        })
        .catch(() => { /* still waiting */ })
    }, 8000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="signin-wall">
      <div className="signin-card">
        <Wordmark />
        <div className="pending-identity">
          {user.avatarUrl
            ? <img src={user.avatarUrl} alt="" className="avatar avatar-img" />
            : <span className="avatar">{initialOf(user.displayName)}</span>}
          <span className="pending-identity-copy">
            <span className="side-user-name">{user.displayName}</span>
            <span className="pending-sub">@{user.githubLogin}</span>
          </span>
        </div>
        <p className="signin-copy">
          You're signed in — a teacher just needs to approve this account before
          you can join the boards. Hang tight; this page opens on its own once
          you're in.
        </p>
        <p className="pending-status">Checking automatically…</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
        <p className="signin-foot">Dixie Tech · Software Development</p>
      </div>
    </div>
  )
}

function ReviewStudents({
  pending, onResolve,
}: {
  pending: PendingUser[]
  onResolve: (id: string, approve: boolean) => Promise<void>
}) {
  const [busyId, setBusyId] = useState('')

  async function resolve(id: string, approve: boolean) {
    setBusyId(id)
    try {
      await onResolve(id, approve)
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <h3 className="panel-title">Sign-up requests</h3>
          <span className="panel-note">
            {pending.length === 0 ? 'nothing waiting' : `${pending.length} waiting`}
          </span>
        </div>
        {pending.length === 0 ? (
          <p className="quiet-text">No one is waiting — new GitHub sign-ins land here for approval before they can enter the app.</p>
        ) : (
          <ul className="pending-list">
            {pending.map((person) => (
              <li key={person.id} className="pending-row">
                {person.avatarUrl
                  ? <img src={person.avatarUrl} alt="" className="avatar avatar-img" />
                  : <span className="avatar">{initialOf(person.displayName)}</span>}
                <div className="pending-copy">
                  <span className="pending-name">{person.displayName}</span>
                  <span className="pending-sub">
                    @{person.githubLogin}{person.email ? ` · ${person.email}` : ''} · requested {formatRelativeTime(person.requestedAt)}
                  </span>
                </div>
                <a
                  className="btn btn-ghost btn-sm"
                  href={`https://github.com/${person.githubLogin}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub profile
                </a>
                <button type="button" className="btn btn-primary btn-sm" disabled={busyId === person.id}
                  onClick={() => void resolve(person.id, true)}>
                  Approve
                </button>
                <button type="button" className="btn btn-ghost btn-sm btn-reject" disabled={busyId === person.id}
                  title="Removes the request — they can sign in again to re-request"
                  onClick={() => void resolve(person.id, false)}>
                  Reject
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── AdminPanel ────────────────────────────────────────────────────────────────

function InlineRenameInput({
  value, ariaLabel, onCommit,
}: {
  value: string
  ariaLabel: string
  onCommit: (name: string) => void
}) {
  const [draft, setDraft] = useState(value)

  function commit() {
    const name = draft.trim()
    if (!name || name === value) { setDraft(value); return }
    onCommit(name)
  }

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setDraft(value)
      }}
      aria-label={ariaLabel}
    />
  )
}

function TeamManageRow({
  team, projects, canArchive, onUpdate,
}: {
  team: Team
  projects: Project[]
  canArchive: boolean
  onUpdate: (slug: string, patch: { name?: string; archived?: boolean; projectSlug?: string }) => Promise<void>
}) {
  const projectOptions = projects.filter((p) => !p.archived || p.slug === team.projectSlug)
  return (
    <li className={`team-manage-row ${team.archived ? 'team-archived' : ''}`}>
      <InlineRenameInput value={team.name} ariaLabel={`Rename ${team.name}`}
        onCommit={(name) => void onUpdate(team.slug, { name })} />
      {projectOptions.length > 1 && (
        <select
          value={team.projectSlug ?? ''}
          onChange={(e) => void onUpdate(team.slug, { projectSlug: e.target.value })}
          aria-label={`Move ${team.name} to another project`}
        >
          {projectOptions.map((p) => (
            <option key={p.slug} value={p.slug}>{p.name}{p.archived ? ' (archived)' : ''}</option>
          ))}
        </select>
      )}
      {team.archived ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onUpdate(team.slug, { archived: false })}>
          Restore
        </button>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" disabled={!canArchive}
          title={canArchive ? 'Hide this board; cards and history are kept' : 'At least one team must stay active'}
          onClick={() => void onUpdate(team.slug, { archived: true })}>
          Archive
        </button>
      )}
    </li>
  )
}

function AddRow({
  placeholder, buttonLabel, onAdd,
}: {
  placeholder: string
  buttonLabel: string
  onAdd: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [isBusy, setIsBusy] = useState(false)

  async function submit() {
    const trimmed = name.trim()
    if (!trimmed || isBusy) return
    setIsBusy(true)
    try {
      await onAdd(trimmed)
      setName('')
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="goal-input-row team-add-row">
      <input
        type="text"
        placeholder={placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
      />
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={!name.trim() || isBusy}>
        {isBusy ? 'Adding…' : buttonLabel}
      </button>
    </div>
  )
}

// One user's team memberships: chips with a per-team role toggle and remove,
// plus a row to add them to another team.
function MembershipsEditor({
  person, teams, onChange,
}: {
  person: RosterUser
  teams: Team[]
  onChange: (memberships: Membership[]) => void
}) {
  const [addTeam, setAddTeam] = useState('')

  const availableTeams = teams.filter(
    (t) => !t.archived && !person.memberships.some((m) => m.team === t.slug),
  )
  const nameOf = (slug: string) => teams.find((t) => t.slug === slug)?.name ?? slug

  function setRole(team: TeamId, role: MemberRole) {
    onChange(person.memberships.map((m) => (m.team === team ? { ...m, role } : m)))
  }

  function remove(team: TeamId) {
    onChange(person.memberships.filter((m) => m.team !== team))
  }

  function add() {
    if (!addTeam) return
    onChange([...person.memberships, { team: addTeam, role: 'member' }])
    setAddTeam('')
  }

  return (
    <div className="memberships-cell">
      {person.memberships.length === 0 && <span className="quiet-text">No teams</span>}
      {person.memberships.map((m) => (
        <span key={m.team} className="membership-chip">
          <span className="membership-team">{nameOf(m.team)}</span>
          <button
            type="button"
            className={`membership-role ${m.role === 'pm' ? 'is-pm' : ''}`}
            title={m.role === 'pm' ? 'Demote to member' : 'Promote to PM of this team'}
            onClick={() => setRole(m.team, m.role === 'pm' ? 'member' : 'pm')}
          >
            {m.role === 'pm' ? 'PM' : 'Member'}
          </button>
          <button type="button" className="membership-remove" aria-label={`Remove from ${nameOf(m.team)}`}
            onClick={() => remove(m.team)}>✕</button>
        </span>
      ))}
      {availableTeams.length > 0 && (
        <span className="membership-add">
          <select value={addTeam} onChange={(e) => setAddTeam(e.target.value)} aria-label={`Add ${person.displayName} to a team`}>
            <option value="">Add to team…</option>
            {availableTeams.map((t) => (
              <option key={t.slug} value={t.slug}>{t.name}</option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={!addTeam}>Add</button>
        </span>
      )}
    </div>
  )
}

function AdminPanel({
  teams, projects, onCreateTeam, onUpdateTeam, onCreateProject, onUpdateProject,
}: {
  teams: Team[]
  projects: Project[]
  onCreateTeam: (name: string, projectSlug: string) => Promise<void>
  onUpdateTeam: (slug: string, patch: { name?: string; archived?: boolean; projectSlug?: string }) => Promise<void>
  onCreateProject: (name: string) => Promise<void>
  onUpdateProject: (slug: string, patch: { name?: string; archived?: boolean }) => Promise<void>
}) {
  const [users, setUsers] = useState<RosterUser[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const archivedProjectSlugs = new Set(projects.filter((p) => p.archived).map((p) => p.slug))
  const visibleTeamCount = teams.filter(
    (t) => !t.archived && !(t.projectSlug && archivedProjectSlugs.has(t.projectSlug)),
  ).length
  const orphanTeams = teams.filter((t) => !t.projectSlug || !projects.some((p) => p.slug === t.projectSlug))

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

  async function handleMembershipsChange(userId: string, memberships: Membership[]) {
    setError('')
    try {
      const updated = await updateUserMemberships(userId, memberships)
      setUsers((cur) => cur.map((u) => (u.id === userId ? updated : u)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update user.')
    }
  }

  async function handleAdminChange(person: RosterUser) {
    setError('')
    try {
      const updated = await setUserAdmin(person.id, !person.isAdmin)
      setUsers((cur) => cur.map((u) => (u.id === person.id ? updated : u)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update admin access.')
    }
  }

  return (
    <div className="page">
      {error && <p className="form-error">{error}</p>}

      <section className="panel">
        <div className="panel-head">
          <h3 className="panel-title">Projects &amp; teams</h3>
          <span className="panel-note">a project groups the boards for one set of class work</span>
        </div>
        {projects.map((project) => {
          const projectTeams = teams.filter((t) => t.projectSlug === project.slug)
          return (
            <div key={project.slug} className={`project-group ${project.archived ? 'team-archived' : ''}`}>
              <div className="project-group-head">
                <InlineRenameInput value={project.name} ariaLabel={`Rename project ${project.name}`}
                  onCommit={(name) => void onUpdateProject(project.slug, { name })} />
                {project.archived ? (
                  <button type="button" className="btn btn-ghost btn-sm"
                    onClick={() => void onUpdateProject(project.slug, { archived: false })}>
                    Restore
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm"
                    title="Hide this project's boards; all cards and history are kept"
                    onClick={() => void onUpdateProject(project.slug, { archived: true })}>
                    Archive
                  </button>
                )}
              </div>
              <ul className="team-manage-list">
                {projectTeams.map((team) => (
                  <TeamManageRow key={team.slug} team={team} projects={projects}
                    canArchive={visibleTeamCount > 1} onUpdate={onUpdateTeam} />
                ))}
              </ul>
              {!project.archived && (
                <AddRow placeholder={`New team in ${project.name}…`} buttonLabel="Add team"
                  onAdd={(name) => onCreateTeam(name, project.slug)} />
              )}
            </div>
          )
        })}
        {orphanTeams.length > 0 && (
          <div className="project-group">
            <div className="project-group-head"><span className="pm-group-label">No project</span></div>
            <ul className="team-manage-list">
              {orphanTeams.map((team) => (
                <TeamManageRow key={team.slug} team={team} projects={projects}
                  canArchive={visibleTeamCount > 1} onUpdate={onUpdateTeam} />
              ))}
            </ul>
          </div>
        )}
        <AddRow placeholder="New project name…" buttonLabel="Add project" onAdd={onCreateProject} />
      </section>

      {isLoading ? (
        <div className="panel"><SkeletonLines rows={3} /></div>
      ) : (
        <div className="panel table-panel">
          <table className="admin-table">
            <thead>
              <tr><th>Name</th><th>GitHub</th><th>Teams &amp; roles</th><th>Admin</th></tr>
            </thead>
            <tbody>
              {users.map((person) => (
                <tr key={person.id}>
                  <td>
                    <span className="admin-user">
                      <span className="avatar avatar-sm">{initialOf(person.displayName)}</span>
                      {person.displayName}
                    </span>
                  </td>
                  <td className="admin-login">@{person.githubLogin}</td>
                  <td>
                    <MembershipsEditor
                      person={person}
                      teams={teams}
                      onChange={(memberships) => void handleMembershipsChange(person.id, memberships)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`membership-role ${person.isAdmin ? 'is-pm' : ''}`}
                      disabled={person.envAdmin}
                      title={
                        person.envAdmin
                          ? 'Always an admin — set in the server config'
                          : person.isAdmin ? 'Remove admin access' : 'Make this person an admin'
                      }
                      onClick={() => void handleAdminChange(person)}
                    >
                      {person.isAdmin ? 'Admin' : 'Student'}
                    </button>
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
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeTab, setActiveTab] = useState<TabId>('')
  const [qnaItems, setQnaItems] = useState<QnaQuestion[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [githubConfigured, setGithubConfigured] = useState(true)
  const [authChecked, setAuthChecked] = useState(false)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [myTasksOnly, setMyTasksOnly] = useState(false)
  const [dashboardTeam, setDashboardTeam] = useState<TeamId>('')
  const [checkinTeam, setCheckinTeam] = useState<TeamId>('')
  const [notesTeam, setNotesTeam] = useState<TeamId>('')
  const [selectedCardId, setSelectedCardId] = useState<Task['id'] | null>(null)
  const [newCardOpen, setNewCardOpen] = useState(false)

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
        // Land on the user's own (first PM) team in Dashboard/Check-ins.
        const firstPmTeam = data.user?.memberships.find((m) => m.role === 'pm')?.team
        if (firstPmTeam) {
          setDashboardTeam(firstPmTeam)
          setCheckinTeam(firstPmTeam)
        }
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
    // No data requests while the account waits at the approval gate — the
    // server would 403 them all anyway.
    if (!authUser || authUser.approvalStatus !== 'approved') return
    const isAdmin = authUser.isAdmin
    let isActive = true
    async function load() {
      try {
        setIsLoading(true); setError('')
        const [cards, questions, users, teamData, pending] = await Promise.all([
          fetchCards(), fetchQuestions(), fetchRoster(), fetchTeams(),
          isAdmin ? fetchPendingUsers() : Promise.resolve([]),
        ])
        if (isActive) {
          setTasks(cards)
          setQnaItems(questions)
          setRoster(users)
          setPendingUsers(pending)
          setTeams(teamData.teams)
          setProjects(teamData.projects)
          const archivedProjects = new Set(teamData.projects.filter((p) => p.archived).map((p) => p.slug))
          const firstVisible = teamData.teams.find(
            (t) => !t.archived && !(t.projectSlug && archivedProjects.has(t.projectSlug)),
          ) ?? teamData.teams[0]
          if (firstVisible) setActiveTab((cur) => (cur ? cur : firstVisible.slug))
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

  const activeProjects = projects.filter((p) => !p.archived)
  const archivedProjectSlugs = new Set(projects.filter((p) => p.archived).map((p) => p.slug))
  // A team is visible when neither it nor its project is archived.
  const visibleTeams = teams.filter(
    (t) => !t.archived && !(t.projectSlug && archivedProjectSlugs.has(t.projectSlug)),
  )
  const teamNames: Record<TeamId, string> = Object.fromEntries(teams.map((t) => [t.slug, t.name]))
  const tasksFor = (slug: TeamId) => tasks.filter((t) => t.team === slug)
  const rawActiveTasks = tasksFor(activeTab)
  const activeTasks = myTasksOnly
    ? rawActiveTasks.filter((t) => t.assigneeUserId === authUser?.id)
    : rawActiveTasks
  const defaultName = authUser?.displayName ?? ''

  function selectTab(tab: TabId) {
    setActiveTab(tab)
  }

  async function handleCreateTeam(name: string, projectSlug: string) {
    setError('')
    try {
      const created = await createTeam(name, projectSlug)
      setTeams((cur) => [...cur, created])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create team.')
    }
  }

  async function handleUpdateTeam(slug: string, patch: { name?: string; archived?: boolean; projectSlug?: string }) {
    setError('')
    try {
      const updated = await updateTeam(slug, patch)
      setTeams((cur) => cur.map((t) => (t.slug === slug ? updated : t)))
      if (patch.archived && activeTab === slug) {
        const nextTeam = visibleTeams.find((t) => t.slug !== slug)
        setActiveTab(nextTeam ? nextTeam.slug : 'admin')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update team.')
    }
  }

  async function handleCreateProject(name: string) {
    setError('')
    try {
      const created = await createProject(name)
      setProjects((cur) => [...cur, created])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create project.')
    }
  }

  async function handleUpdateProject(slug: string, patch: { name?: string; archived?: boolean }) {
    setError('')
    try {
      const updated = await updateProject(slug, patch)
      setProjects((cur) => cur.map((p) => (p.slug === slug ? updated : p)))
      if (patch.archived) {
        const activeTeam = teams.find((t) => t.slug === activeTab)
        if (activeTeam?.projectSlug === slug) {
          const nextTeam = visibleTeams.find((t) => t.projectSlug !== slug)
          setActiveTab(nextTeam ? nextTeam.slug : 'admin')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update project.')
    }
  }

  async function handleCreateTask(draft: TaskDraft): Promise<boolean> {
    const title = draft.title.trim(); if (!title) return false
    setError('')
    try {
      const card = await createCard({
        title,
        description: draft.description.trim(),
        assigneeUserId: draft.assigneeUserId,
        dueDate: draft.dueDate,
        tags: buildTags(draft.presetTags),
        team: draft.team,
        cardStatus: 'started',
        priority: draft.priority,
      })
      setTasks((cur) => [...cur, card])
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create card.')
      return false
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

  async function handleDeleteTask(id: Task['id']): Promise<boolean> {
    setError('')
    try {
      await deleteCard(id)
      setTasks((cur) => cur.filter((t) => t.id !== id))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete card.')
      return false
    }
  }

  function handleDropCard(id: string, status: CardStatus) {
    const current = tasks.find((t) => String(t.id) === id)
    if (!current || current.cardStatus === status) return
    void handleUpdateTask(current.id, { cardStatus: status })
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

  async function handleResolveSignup(userId: string, approve: boolean) {
    setError('')
    try {
      await resolveSignup(userId, approve)
      setPendingUsers((cur) => cur.filter((u) => u.id !== userId))
      // A newly approved student should show up in rosters and assignee
      // pickers right away.
      if (approve) fetchRoster().then(setRoster).catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the request.')
    }
  }

  // Re-check for new sign-up requests whenever the Review tab is opened.
  useEffect(() => {
    if (activeTab !== 'review' || !authUser?.isAdmin) return
    let isActive = true
    fetchPendingUsers()
      .then((users) => { if (isActive) setPendingUsers(users) })
      .catch(() => {})
    return () => { isActive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  if (!authUser) {
    return (
      <div className="signin-wall">
        <div className="signin-card">
          <Wordmark />
          {!authChecked ? (
            <p className="quiet-text">Loading…</p>
          ) : !githubConfigured ? (
            <p className="quiet-text">GitHub OAuth not configured</p>
          ) : (
            <>
              <p className="signin-copy">Track your team's work — boards, priorities, and accountability for the class projects.</p>
              <a className="btn btn-primary signin-btn" href="/auth/github/start">Sign in with GitHub</a>
            </>
          )}
          <p className="signin-foot">Dixie Tech · Software Development</p>
        </div>
      </div>
    )
  }

  if (authUser.approvalStatus !== 'approved') {
    return (
      <PendingApprovalScreen
        user={authUser}
        onStatusChange={setAuthUser}
        onLogout={() => void handleLogout()}
      />
    )
  }

  const pmTeams = authUser.memberships.filter((m) => m.role === 'pm').map((m) => m.team)
  const isPm = pmTeams.length > 0
  // Mirrors the server's rules: edits are for the assignee, the card's team PM,
  // or an admin; deletion adds the creator (accountable — deletions are theirs).
  const canEditTask = (t: Task) => authUser.isAdmin || pmTeams.includes(t.team) || t.assigneeUserId === authUser.id
  const canDeleteTask = (t: Task) => authUser.isAdmin || pmTeams.includes(t.team) || t.createdByUserId === authUser.id
  const canSeeDashboard = authUser.isAdmin || isPm
  const canManageCheckins = canSeeDashboard
  const firstTeamSlug = visibleTeams[0]?.slug ?? ''
  // Admins pick among all visible teams; PMs among the teams they run.
  const resolvePickedTeam = (picked: TeamId): TeamId => {
    const candidates = authUser.isAdmin ? visibleTeams.map((t) => t.slug) : pmTeams
    if (candidates.includes(picked)) return picked
    return candidates[0] ?? firstTeamSlug
  }
  const dashboardTeamResolved: TeamId = resolvePickedTeam(dashboardTeam)
  const checkinTeamResolved: TeamId = resolvePickedTeam(checkinTeam)
  const notesTeamResolved: TeamId = pmTeams.includes(notesTeam) ? notesTeam : (pmTeams[0] ?? '')
  const isBoardView = teams.some((t) => t.slug === activeTab)
  const selectedCard = selectedCardId === null ? null : tasks.find((t) => t.id === selectedCardId) ?? null

  const viewTitle =
    activeTab === 'qna' ? 'Q&A'
    : activeTab === 'dashboard' ? `${teamNames[dashboardTeamResolved] ?? ''} Dashboard`
    : activeTab === 'notes' ? `${teamNames[notesTeamResolved] ?? notesTeamResolved} Notes`
    : activeTab === 'checkins' && canManageCheckins ? `${teamNames[checkinTeamResolved] ?? ''} Check-ins`
    : activeTab === 'checkins' || activeTab === 'my-checkins' ? 'My check-ins'
    : activeTab === 'admin' ? 'Manage roles'
    : activeTab === 'review' ? 'Review new students'
    : `${teamNames[activeTab] ?? activeTab} Board`

  // Remounting the keyed wrapper below replays the view-in animation whenever
  // the tab — or the team inside a PM view — changes.
  const viewKey =
    activeTab === 'dashboard' ? `dashboard-${dashboardTeamResolved}`
    : activeTab === 'notes' ? `notes-${notesTeamResolved}`
    : activeTab === 'checkins' && canManageCheckins ? `checkins-${checkinTeamResolved}`
    : activeTab

  const viewEyebrow =
    activeTab === 'qna' ? 'Forum'
    : activeTab === 'dashboard' || activeTab === 'notes' ? 'PM view'
    : activeTab === 'checkins' && canManageCheckins ? 'PM view'
    : activeTab === 'checkins' || activeTab === 'my-checkins' ? 'You'
    : activeTab === 'admin' || activeTab === 'review' ? 'Admin'
    : 'Board'

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand"><Wordmark /></div>
        <nav className="side-nav">
          {activeProjects.map((project) => {
            const projectTeams = visibleTeams.filter((t) => t.projectSlug === project.slug)
            if (projectTeams.length === 0) return null
            return (
              <Fragment key={project.slug}>
                <p className="nav-eyebrow">{project.name}</p>
                {projectTeams.map((team) => (
                  <TeamNavItem
                    key={team.slug}
                    label={team.name}
                    active={activeTab === team.slug}
                    count={tasksFor(team.slug).length}
                    onClick={() => selectTab(team.slug)}
                    onRename={authUser.isAdmin ? (n) => void handleUpdateTeam(team.slug, { name: n }) : undefined}
                  />
                ))}
              </Fragment>
            )
          })}
          {visibleTeams.some((t) => !t.projectSlug || !projects.some((p) => p.slug === t.projectSlug)) && (
            <Fragment>
              <p className="nav-eyebrow">Boards</p>
              {visibleTeams.filter((t) => !t.projectSlug || !projects.some((p) => p.slug === t.projectSlug)).map((team) => (
                <TeamNavItem
                  key={team.slug}
                  label={team.name}
                  active={activeTab === team.slug}
                  count={tasksFor(team.slug).length}
                  onClick={() => selectTab(team.slug)}
                  onRename={authUser.isAdmin ? (n) => void handleUpdateTeam(team.slug, { name: n }) : undefined}
                />
              ))}
            </Fragment>
          )}
          <p className="nav-eyebrow">General</p>
          <NavItem icon="qna" label="Q&A" active={activeTab === 'qna'} onClick={() => selectTab('qna')} />
          <NavItem icon="checkins" label="My Check-ins" active={activeTab === 'my-checkins'} onClick={() => selectTab('my-checkins')} />
          {canSeeDashboard && (
            <p className="nav-eyebrow">Manage</p>
          )}
          {canSeeDashboard && (
            <NavItem icon="dashboard" label="Dashboard" active={activeTab === 'dashboard'} onClick={() => selectTab('dashboard')} />
          )}
          {canManageCheckins && (
            <NavItem icon="checkins" label="Check-ins" active={activeTab === 'checkins'} onClick={() => selectTab('checkins')} />
          )}
          {isPm && (
            <NavItem icon="notes" label="PM Notes" active={activeTab === 'notes'} onClick={() => selectTab('notes')} />
          )}
          {authUser.isAdmin && (
            <>
              <p className="nav-eyebrow">Admin</p>
              <NavItem icon="admin" label="Admin" active={activeTab === 'admin'} onClick={() => selectTab('admin')} />
              <NavItem
                icon="review"
                label="Review students"
                active={activeTab === 'review'}
                onClick={() => selectTab('review')}
                badge={pendingUsers.length > 0 ? String(pendingUsers.length) : undefined}
              />
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <ThemeToggle theme={theme} onToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} />
          <SidebarUser
            key={authUser.id}
            user={authUser}
            teamNames={teamNames}
            onLogout={() => void handleLogout()}
            onUserUpdate={setAuthUser}
          />
        </div>
      </aside>

      <div className="main">
        <header className="view-bar">
          <div className="view-title-wrap">
            <p className="view-eyebrow">{viewEyebrow}</p>
            <h1 className="view-title">{viewTitle}</h1>
          </div>
          <div className="view-actions">
            {(() => {
              // Team switcher for the PM views. Dashboard and Check-ins let an
              // admin pick any visible team; PM Notes is strictly the teams the
              // viewer holds the PM role on (the server rejects anything else,
              // even for admins, so the picker must match).
              const pmPickerTeams = teams.filter((t) => pmTeams.includes(t.slug))
              const managePickerTeams = authUser.isAdmin ? visibleTeams : pmPickerTeams
              const pickers: Partial<Record<string, [TeamId, (slug: TeamId) => void, Team[]]>> = {
                dashboard: [dashboardTeamResolved, setDashboardTeam, managePickerTeams],
                checkins: [checkinTeamResolved, setCheckinTeam, managePickerTeams],
                notes: [notesTeamResolved, setNotesTeam, pmPickerTeams],
              }
              const picker = pickers[activeTab]
              if (!picker || (activeTab === 'checkins' && !canManageCheckins)) return null
              const [selected, setSelected, pickerTeams] = picker
              if (pickerTeams.length < 2) return null
              return (
                <div className="segmented">
                  {pickerTeams.map((t) => (
                    <label key={t.slug} className={`segment ${selected === t.slug ? 'selected' : ''}`}>
                      <input type="radio" name={`${activeTab}-team`}
                        checked={selected === t.slug} onChange={() => setSelected(t.slug)} />
                      {t.name}
                    </label>
                  ))}
                </div>
              )
            })()}
            {isBoardView && (
              <>
                <button
                  type="button"
                  className={`filter-chip ${myTasksOnly ? 'active' : ''}`}
                  onClick={() => setMyTasksOnly((v) => !v)}
                  aria-pressed={myTasksOnly}
                >
                  My Tasks
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setNewCardOpen(true)}>
                  + New card
                </button>
              </>
            )}
          </div>
        </header>

        <div className="view-body">
          {error && <p className="error-banner">{error}</p>}

          <div key={viewKey} className="view-fade">
          {activeTab === 'notes' && isPm && notesTeamResolved ? (
            <PmNotes
              key={notesTeamResolved}
              team={notesTeamResolved}
              tasks={tasksFor(notesTeamResolved)}
              teamName={teamNames[notesTeamResolved] ?? notesTeamResolved}
            />
          ) : activeTab === 'dashboard' && canSeeDashboard ? (
            <Dashboard
              key={dashboardTeamResolved}
              team={dashboardTeamResolved}
              teamName={teamNames[dashboardTeamResolved] ?? dashboardTeamResolved}
              tasks={tasksFor(dashboardTeamResolved)}
            />
          ) : activeTab === 'checkins' && canManageCheckins ? (
            <TeamCheckins
              key={checkinTeamResolved}
              team={checkinTeamResolved}
              teamName={teamNames[checkinTeamResolved] ?? checkinTeamResolved}
              roster={roster}
              tasks={tasksFor(checkinTeamResolved)}
            />
          ) : activeTab === 'checkins' || activeTab === 'my-checkins' ? (
            <MyCheckins />
          ) : activeTab === 'review' && authUser.isAdmin ? (
            <ReviewStudents pending={pendingUsers} onResolve={handleResolveSignup} />
          ) : activeTab === 'admin' && authUser.isAdmin ? (
            <AdminPanel
              teams={teams}
              projects={projects}
              onCreateTeam={handleCreateTeam}
              onUpdateTeam={handleUpdateTeam}
              onCreateProject={handleCreateProject}
              onUpdateProject={handleUpdateProject}
            />
          ) : activeTab === 'qna' ? (
            <div className="page qna-page">
              <QnaComposer onPost={handleCreateQuestion} defaultName={defaultName} />
              {qnaItems.length === 0 ? (
                <p className="quiet-text">No questions yet — post the first one.</p>
              ) : (
                <div className="qna-list">
                  {qnaItems.map((item) => (
                    <QnaCard key={item.id} item={item} defaultName={defaultName} onAddAnswer={handleCreateAnswer} />
                  ))}
                </div>
              )}
            </div>
          ) : isLoading ? (
            <SkeletonBoard />
          ) : (
            <div className="board">
              {CARD_STATUSES.map((s) => (
                <BoardColumn
                  key={s.id}
                  sectionId={s.id}
                  label={s.label}
                  tasks={activeTasks.filter((t) => t.cardStatus === s.id)}
                  canEditCard={canEditTask}
                  onOpen={setSelectedCardId}
                  onDropCard={handleDropCard}
                />
              ))}
            </div>
          )}
          </div>
        </div>
      </div>

      {selectedCard && (
        <CardDetailModal
          key={String(selectedCard.id)}
          task={selectedCard}
          roster={roster}
          teams={visibleTeams.some((t) => t.slug === selectedCard.team)
            ? visibleTeams
            : [...visibleTeams, ...teams.filter((t) => t.slug === selectedCard.team)]}
          teamNames={teamNames}
          canEdit={canEditTask(selectedCard)}
          canDelete={canDeleteTask(selectedCard)}
          onUpdate={handleUpdateTask}
          onDelete={handleDeleteTask}
          onClose={() => setSelectedCardId(null)}
        />
      )}
      {newCardOpen && isBoardView && (
        <NewCardModal
          defaultTeam={activeTab}
          defaultAssigneeId={authUser.id}
          roster={roster}
          teams={visibleTeams}
          teamNames={teamNames}
          onCreate={handleCreateTask}
          onClose={() => setNewCardOpen(false)}
        />
      )}
    </div>
  )
}

export default App
