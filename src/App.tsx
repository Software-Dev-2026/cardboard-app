import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import './App.css'
import { isSupabaseConfigured, supabase } from './utils/supabase'

// ── Types ─────────────────────────────────────────────────────────────────────

type TeamId = 'team1' | 'team2'
type TabId = 'team1' | 'team2' | 'qna' | 'notes'
type ManagerId = 'manager1' | 'manager2'
type CardStatus = 'started' | 'flowing' | 'done'

const PRESET_TAGS = ['Blocked', 'Need Help'] as const

const CARD_STATUSES: Array<{ id: CardStatus; label: string; shortLabel: string }> = [
  { id: 'started', label: 'Just Started / My Idea', shortLabel: 'Just Started' },
  { id: 'flowing', label: "I'm in the Flow",        shortLabel: 'In the Flow'   },
  { id: 'done',    label: 'Finishing Up / Done',    shortLabel: 'Done'          },
]

interface Task {
  id: number | string
  title: string
  description: string
  assignee: string
  dueDate: string
  tags: string[]
  team: TeamId
  cardStatus: CardStatus
}

interface EditState {
  title: string
  description: string
  assignee: string
  dueDate: string
  presetTags: string[]
  customTags: string
  team: TeamId
  cardStatus: CardStatus
}

interface TaskDraft {
  title: string
  description: string
  assignee: string
  dueDate: string
  presetTags: string[]
  customTags: string
  team: TeamId
}

interface RemoteTaskRow {
  id: number | string
  name: string | null
  description: string | null
  assignee: string | null
  due_date: string | null
  tags: string[] | null
  status: string | null
  order_index: number | null
}

interface QnaQuestion {
  id: string
  question: string
  author: string
  answers: QnaAnswer[]
}

interface QnaAnswer {
  id: string
  text: string
  author: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const REMOTE_SELECT = 'id, name, description, assignee, due_date, tags, status, order_index'
const TODAY = new Date()

const DEMO_TASKS: Task[] = [
  {
    id: 'demo-1',
    title: 'Design system audit',
    description: 'Review component library for consistency gaps before the Q3 release.',
    assignee: 'Jordan',
    dueDate: offsetDate(3),
    tags: ['Design', 'Q3'],
    team: 'team1',
    cardStatus: 'flowing',
  },
  {
    id: 'demo-2',
    title: 'Onboarding flow revamp',
    description: 'Simplify the 5-step onboarding to 3 steps based on drop-off data.',
    assignee: 'Avery',
    dueDate: offsetDate(7),
    tags: ['UX', 'Blocked'],
    team: 'team1',
    cardStatus: 'started',
  },
  {
    id: 'demo-3',
    title: 'Write release notes',
    description: 'Draft v2.4 release notes covering new features and bug fixes.',
    assignee: 'Morgan',
    dueDate: offsetDate(1),
    tags: ['Docs'],
    team: 'team1',
    cardStatus: 'done',
  },
  {
    id: 'demo-4',
    title: 'API rate limit investigation',
    description: 'Spike on why heavy users are hitting 429s on the /export endpoint.',
    assignee: 'Riley',
    dueDate: offsetDate(2),
    tags: ['Backend', 'Blocked'],
    team: 'team2',
    cardStatus: 'started',
  },
  {
    id: 'demo-5',
    title: 'Mobile push notification opt-in',
    description: 'Implement opt-in prompt and preference storage for push notifications.',
    assignee: 'Casey',
    dueDate: offsetDate(6),
    tags: ['Mobile'],
    team: 'team2',
    cardStatus: 'flowing',
  },
  {
    id: 'demo-6',
    title: 'Accessibility pass — settings page',
    description: 'Run axe-core and fix all critical a11y violations on the settings screen.',
    assignee: 'Avery',
    dueDate: offsetDate(10),
    tags: ['A11y', 'Need Help'],
    team: 'team2',
    cardStatus: 'done',
  },
]

const DEMO_QNA: QnaQuestion[] = [
  {
    id: 'qna-1',
    question: 'What is the deadline for the Q3 launch?',
    author: 'Jordan',
    answers: [
      { id: 'ans-1', text: 'Target is end of July — marketing needs assets by the 20th.', author: 'Avery' },
    ],
  },
  {
    id: 'qna-2',
    question: 'Who owns the API rate limit investigation?',
    author: 'Casey',
    answers: [],
  },
  {
    id: 'qna-3',
    question: 'Is the new onboarding flow approved by design?',
    author: 'Morgan',
    answers: [
      { id: 'ans-2', text: 'Yes, design signed off on the 3-step version last Tuesday.', author: 'Riley' },
      { id: 'ans-3', text: 'Legal also reviewed and cleared it.', author: 'Jordan' },
    ],
  },
]

const INITIAL_DRAFT: TaskDraft = {
  title: '',
  description: '',
  assignee: '',
  dueDate: offsetDate(4),
  presetTags: [],
  customTags: '',
  team: 'team1',
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildTags(presetTags: string[], customTags: string): string[] {
  return [...presetTags, ...customTags.split(',').map((t) => t.trim()).filter(Boolean)]
}

function taskToEditState(task: Task): EditState {
  const preset = PRESET_TAGS as readonly string[]
  return {
    title: task.title,
    description: task.description,
    assignee: task.assignee,
    dueDate: task.dueDate,
    presetTags: task.tags.filter((t) => preset.includes(t)),
    customTags: task.tags.filter((t) => !preset.includes(t)).join(', '),
    team: task.team,
    cardStatus: task.cardStatus,
  }
}

function encodeStatus(team: TeamId, cardStatus: CardStatus): string {
  return `${team}:${cardStatus}`
}

function decodeStatus(value: string | null): { team: TeamId; cardStatus: CardStatus } {
  const [rawTeam, rawStatus] = (value ?? '').split(':')
  const team: TeamId = rawTeam === 'team2' ? 'team2' : 'team1'
  const cardStatus: CardStatus =
    rawStatus === 'flowing' || rawStatus === 'done' ? rawStatus : 'started'
  return { team, cardStatus }
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

// ── TaskCard ──────────────────────────────────────────────────────────────────

function TaskCard({
  task, index, onUpdate, teamNames,
}: {
  task: Task; index: number
  onUpdate: (id: Task['id'], updated: Partial<Task>) => void
  teamNames: Record<TeamId, string>
}) {
  const [editing, setEditing] = useState(false)
  const [editState, setEditState] = useState<EditState>(() => taskToEditState(task))
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)

  const dueState = getDueState(task.dueDate)

  function startEdit() { setEditState(taskToEditState(task)); setEditing(true) }

  function saveEdit() {
    const title = editState.title.trim(); if (!title) return
    onUpdate(task.id, {
      title,
      description: editState.description.trim(),
      assignee: editState.assignee.trim() || 'Unassigned',
      dueDate: editState.dueDate,
      tags: buildTags(editState.presetTags, editState.customTags),
      team: editState.team,
      cardStatus: editState.cardStatus,
    })
    setEditing(false)
  }

  function updateEdit<K extends keyof EditState>(field: K, value: EditState[K]) {
    setEditState((cur) => ({ ...cur, [field]: value }))
  }

  function submitFeedback() {
    const t = feedbackText.trim(); if (!t) return
    setSubmitted(t); setFeedbackText(''); setShowFeedback(false)
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
          <div className="form-row">
            <label className="field">
              <span>Assignee</span>
              <input type="text" value={editState.assignee}
                onChange={(e) => updateEdit('assignee', e.target.value)} />
            </label>
            <label className="field">
              <span>Due date</span>
              <input type="date" value={editState.dueDate}
                onChange={(e) => updateEdit('dueDate', e.target.value)} />
            </label>
          </div>
          <div className="field">
            <span>Status tags</span>
            <TagToggleRow selected={editState.presetTags}
              onChange={(tags) => updateEdit('presetTags', tags)} />
          </div>
          <label className="field">
            <span>Tags</span>
            <input type="text" placeholder="Design, UX, Backend..." value={editState.customTags}
              onChange={(e) => updateEdit('customTags', e.target.value)} />
          </label>
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
          <span className={`due-pill due-${dueState.tone}`}>{dueState.label}</span>
          <button className="edit-card-btn" onClick={startEdit}>Edit</button>
        </div>
      </div>

      <h4 className="task-title">{task.title}</h4>
      {task.description && <p className="task-desc">{task.description}</p>}

      {task.tags.length > 0 && (
        <div className="tag-row">
          {task.tags.map((tag) => (
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

      {submitted && (
        <div className="feedback-submitted">
          <span className="feedback-submitted-label">Feedback</span>
          <p>{submitted}</p>
          <button className="feedback-edit-btn"
            onClick={() => { setSubmitted(null); setFeedbackText(submitted); setShowFeedback(true) }}>
            Edit
          </button>
        </div>
      )}

      {showFeedback ? (
        <div className="feedback-form">
          <textarea className="feedback-textarea" placeholder="Leave feedback… (⌘↵ to submit)"
            value={feedbackText} rows={3} autoFocus
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitFeedback(); if (e.key === 'Escape') setShowFeedback(false) }} />
          <div className="feedback-actions">
            <button className="action-btn-cancel" onClick={() => setShowFeedback(false)}>Cancel</button>
            <button className="action-btn-save" onClick={submitFeedback} disabled={!feedbackText.trim()}>Submit</button>
          </div>
        </div>
      ) : (
        !submitted && <button className="feedback-btn" onClick={() => setShowFeedback(true)}>+ Feedback</button>
      )}
    </article>
  )
}

// ── SectionColumn ─────────────────────────────────────────────────────────────

function SectionColumn({
  sectionId, label, tasks, onUpdate, teamNames,
}: {
  sectionId: CardStatus; label: string; tasks: Task[]
  onUpdate: (id: Task['id'], updated: Partial<Task>) => void
  teamNames: Record<TeamId, string>
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
            <TaskCard key={task.id} task={task} index={i} onUpdate={onUpdate} teamNames={teamNames} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── QnaCard ───────────────────────────────────────────────────────────────────

function QnaCard({ item, onAddAnswer }: { item: QnaQuestion; onAddAnswer: (id: string, ans: QnaAnswer) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [authorName, setAuthorName] = useState('')

  function submitAnswer() {
    const text = answerText.trim(); if (!text) return
    onAddAnswer(item.id, { id: `ans-${Date.now()}`, text, author: authorName.trim() || 'Anonymous' })
    setAnswerText('')
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
              <input className="answer-author-input" type="text" placeholder="Your name"
                value={authorName} onChange={(e) => setAuthorName(e.target.value)} />
              <button className="action-btn-save" onClick={submitAnswer} disabled={!answerText.trim()}>Answer</button>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

// ── QnaComposer ───────────────────────────────────────────────────────────────

function QnaComposer({ onPost }: { onPost: (q: QnaQuestion) => void }) {
  const [question, setQuestion] = useState('')
  const [author, setAuthor] = useState('')
  function handleSubmit(e: FormEvent) {
    e.preventDefault(); const q = question.trim(); if (!q) return
    onPost({ id: `qna-${Date.now()}`, question: q, author: author.trim() || 'Anonymous', answers: [] })
    setQuestion('')
  }
  return (
    <form className="composer-form" onSubmit={handleSubmit}>
      <label className="field">
        <span>Your question</span>
        <textarea placeholder="What do you need to know?" value={question} rows={4}
          onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <label className="field">
        <span>Your name</span>
        <input type="text" placeholder="Jordan" value={author} onChange={(e) => setAuthor(e.target.value)} />
      </label>
      <button className="primary-button" type="submit" disabled={!question.trim()}>Post question</button>
    </form>
  )
}

// ── ManagerNotes ──────────────────────────────────────────────────────────────

function ManagerNotes({ tasks, teamNames }: { tasks: Record<TeamId, Task[]>; teamNames: Record<TeamId, string> }) {
  const [activeManager, setActiveManager] = useState<ManagerId>('manager1')
  const [notes, setNotes] = useState<Record<ManagerId, Record<string, string>>>({ manager1: {}, manager2: {} })

  const activeTeam: TeamId = activeManager === 'manager1' ? 'team1' : 'team2'
  const activeTeamTasks = tasks[activeTeam]

  function setNote(taskId: string, text: string) {
    setNotes((cur) => ({ ...cur, [activeManager]: { ...cur[activeManager], [taskId]: text } }))
  }

  return (
    <div className="notes-page">
      <div className="notes-header">
        <div><p className="eyebrow">Manager View</p><h2 className="notes-title">Notes</h2></div>
        <div className="manager-toggle">
          {(['manager1', 'manager2'] as ManagerId[]).map((mid) => {
            const team: TeamId = mid === 'manager1' ? 'team1' : 'team2'
            return (
              <button key={mid} className={`manager-toggle-btn ${activeManager === mid ? 'active' : ''}`}
                onClick={() => setActiveManager(mid)}>
                {teamNames[team]} Manager
              </button>
            )
          })}
        </div>
      </div>
      {activeTeamTasks.length === 0 ? (
        <p className="loading-text">No cards in {teamNames[activeTeam]} yet.</p>
      ) : (
        <div className="notes-grid">
          {activeTeamTasks.map((task) => {
            const dueState = getDueState(task.dueDate)
            const statusInfo = CARD_STATUSES.find((s) => s.id === task.cardStatus)
            return (
              <div key={task.id} className="note-card">
                <div className="note-card-header">
                  <div className="note-card-meta">
                    <span className={`due-pill due-${dueState.tone}`}>{dueState.label}</span>
                    <span className={`section-status-badge section-status-${task.cardStatus}`}>
                      {statusInfo?.shortLabel}
                    </span>
                    {task.tags.map((tag) => (
                      <span key={tag} className={`tag-pill ${tag === 'Blocked' ? 'tag-blocked' : tag === 'Need Help' ? 'tag-need-help' : ''}`}>{tag}</span>
                    ))}
                  </div>
                  <h4 className="note-card-title">{task.title}</h4>
                  <p className="note-card-sub">{task.assignee} · {formatShortDate(task.dueDate)}</p>
                </div>
                <label className="field note-field">
                  <span>Manager notes</span>
                  <textarea className="note-textarea" placeholder="Add observations, blockers, or action items..."
                    value={notes[activeManager][String(task.id)] ?? ''} rows={4}
                    onChange={(e) => setNote(String(task.id), e.target.value)} />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [tasks, setTasks] = useState<Task[]>(DEMO_TASKS)
  const [draft, setDraft] = useState<TaskDraft>(INITIAL_DRAFT)
  const [teamNames, setTeamNames] = useState<Record<TeamId, string>>({ team1: 'Team 1', team2: 'Team 2' })
  const [activeTab, setActiveTab] = useState<TabId>('team1')
  const [qnaItems, setQnaItems] = useState<QnaQuestion[]>(DEMO_QNA)
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (activeTab === 'team1' || activeTab === 'team2') setDraft((cur) => ({ ...cur, team: activeTab }))
  }, [activeTab])

  useEffect(() => {
    let isActive = true
    if (!supabase) return () => { isActive = false }
    const client = supabase
    async function load() {
      setIsLoading(true); setError('')
      const { data, error: err } = await client.from('todos').select(REMOTE_SELECT)
      if (!isActive) return
      if (err) { setError(err.message) } else { setTasks(mapRows(data ?? [])) }
      setIsLoading(false)
    }
    void load()
    return () => { isActive = false }
  }, [])

  const team1Tasks = tasks.filter((t) => t.team === 'team1')
  const team2Tasks = tasks.filter((t) => t.team === 'team2')
  const activeTasks = activeTab === 'team1' ? team1Tasks : team2Tasks

  function updateDraft<K extends keyof TaskDraft>(field: K, value: TaskDraft[K]) {
    setDraft((cur) => ({ ...cur, [field]: value }))
  }

  async function handleCreateTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const title = draft.title.trim(); if (!title) return
    const tags = buildTags(draft.presetTags, draft.customTags)

    if (!supabase) {
      setTasks((cur) => [...cur, {
        id: `local-${Date.now()}`, title,
        description: draft.description.trim(),
        assignee: draft.assignee.trim() || 'Unassigned',
        dueDate: draft.dueDate, tags,
        team: draft.team, cardStatus: 'started',
      }])
      setDraft((cur) => ({ ...INITIAL_DRAFT, dueDate: offsetDate(4), team: cur.team }))
      return
    }

    setIsSaving(true); setError('')
    const { error: err } = await supabase.from('todos').insert({
      name: title, description: draft.description.trim(),
      assignee: draft.assignee.trim() || 'Unassigned',
      due_date: draft.dueDate || null, tags,
      status: encodeStatus(draft.team, 'started'),
      order_index: tasks.length,
    })
    if (err) { setError(err.message); setIsSaving(false); return }
    const { data } = await supabase.from('todos').select(REMOTE_SELECT)
    if (data) { setTasks(mapRows(data)); setDraft((cur) => ({ ...INITIAL_DRAFT, dueDate: offsetDate(4), team: cur.team })) }
    setIsSaving(false)
  }

  async function handleUpdateTask(id: Task['id'], updated: Partial<Task>) {
    const current = tasks.find((t) => t.id === id)
    if (!current) return
    const merged = { ...current, ...updated }

    if (supabase) {
      const { error: err } = await supabase.from('todos').update({
        name: merged.title, description: merged.description,
        assignee: merged.assignee, due_date: merged.dueDate || null,
        tags: merged.tags, status: encodeStatus(merged.team, merged.cardStatus),
      }).eq('id', id)
      if (err) { setError(err.message); return }
    }
    setTasks((cur) => cur.map((t) => (t.id === id ? merged : t)))
  }

  return (
    <div className="app-shell">
      <div className="orb orb-one" aria-hidden="true" />
      <div className="orb orb-two" aria-hidden="true" />

      <div className="page-wrapper">
        <nav className="tab-bar">
          {(['team1', 'team2'] as TeamId[]).map((tid) => (
            <TabItem key={tid} label={teamNames[tid]} active={activeTab === tid}
              onClick={() => setActiveTab(tid)}
              onRename={(n) => setTeamNames((cur) => ({ ...cur, [tid]: n }))} />
          ))}
          <TabItem label="Q&A" active={activeTab === 'qna'} onClick={() => setActiveTab('qna')} />
          <TabItem label="Manager Notes" active={activeTab === 'notes'} onClick={() => setActiveTab('notes')} />
        </nav>

        {activeTab === 'notes' ? (
          <div className="notes-wrapper">
            <ManagerNotes tasks={{ team1: team1Tasks, team2: team2Tasks }} teamNames={teamNames} />
          </div>
        ) : (
          <main className="app-layout">
            <aside className="composer-panel">
              {activeTab === 'qna' ? (
                <>
                  <div className="composer-heading"><p className="eyebrow">New question</p><h2>Ask away</h2></div>
                  <QnaComposer onPost={(q) => setQnaItems((cur) => [q, ...cur])} />
                </>
              ) : (
                <>
                  <div className="composer-heading"><p className="eyebrow">New card</p><h2>Add card</h2></div>
                  <form className="composer-form" onSubmit={(e) => void handleCreateTask(e)}>
                    <label className="field"><span>Title</span>
                      <input type="text" placeholder="Plan launch office hours" value={draft.title}
                        onChange={(e) => updateDraft('title', e.target.value)} />
                    </label>
                    <label className="field"><span>Description</span>
                      <textarea placeholder="What needs to happen next?" value={draft.description} rows={3}
                        onChange={(e) => updateDraft('description', e.target.value)} />
                    </label>
                    <div className="form-row">
                      <label className="field"><span>Assignee</span>
                        <input type="text" value={draft.assignee}
                          onChange={(e) => updateDraft('assignee', e.target.value)} />
                      </label>
                      <label className="field"><span>Due date</span>
                        <input type="date" value={draft.dueDate}
                          onChange={(e) => updateDraft('dueDate', e.target.value)} />
                      </label>
                    </div>
                    <div className="field"><span>Status tags</span>
                      <TagToggleRow selected={draft.presetTags}
                        onChange={(tags) => updateDraft('presetTags', tags)} />
                    </div>
                    <label className="field"><span>Tags</span>
                      <input type="text" placeholder="Design, UX, Backend..." value={draft.customTags}
                        onChange={(e) => updateDraft('customTags', e.target.value)} />
                    </label>
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
                        onAddAnswer={(qid, ans) =>
                          setQnaItems((cur) => cur.map((q) => q.id === qid ? { ...q, answers: [...q.answers, ans] } : q))} />
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

// ── Data helpers ──────────────────────────────────────────────────────────────

function mapRows(rows: RemoteTaskRow[]): Task[] {
  return rows
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map((row) => {
      const { team, cardStatus } = decodeStatus(row.status)
      return {
        id: row.id,
        title: row.name?.trim() || 'Untitled task',
        description: row.description?.trim() || '',
        assignee: row.assignee?.trim() || 'Unassigned',
        dueDate: row.due_date || '',
        tags: Array.isArray(row.tags) ? row.tags.filter(Boolean) : [],
        team,
        cardStatus,
      }
    })
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

export default App
