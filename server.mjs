import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { neon } from '@neondatabase/serverless'

loadEnv()

const preferredPort = Number(process.env.PORT ?? 5173)
const port = process.env.PORT ? preferredPort : await findAvailablePort(preferredPort)
const isProduction = process.env.NODE_ENV === 'production'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Run `npx -y neonctl env pull` to populate .env.')
}

const sql = neon(databaseUrl)
const activeClassroom = await ensureSchema()
const vite = isProduction
  ? null
  : await import('vite').then(({ createServer: createViteServer }) =>
      createViteServer({ server: { middlewareMode: true }, appType: 'spa' }),
    )

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname.startsWith('/auth/')) {
      await handleAuth(req, res, url)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }

    if (vite) {
      vite.middlewares(req, res)
      return
    }

    serveStatic(url.pathname, res)
  } catch (error) {
    console.error(error)
    sendJson(res, error.status ?? 500, { error: error.message ?? 'Something went wrong.' })
  }
})

server.listen(port, () => {
  console.log(`Cardboard app running at http://localhost:${port}`)
})

async function findAvailablePort(portToTry) {
  const available = await isPortAvailable(portToTry)
  return available ? portToTry : findAvailablePort(portToTry + 1)
}

function isPortAvailable(portToTry) {
  return new Promise((resolve) => {
    const tester = createTcpServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true))
      })
      .listen(portToTry)
  })
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      classroomId: activeClassroom.id,
      slackConfigured: Boolean(process.env.SLACK_WEBHOOK_URL),
    })
    return
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const user = await getCurrentUser(req)
    sendJson(res, 200, { user, githubConfigured: isGithubConfigured() })
    return
  }

  if (url.pathname === '/api/me' && req.method === 'PUT') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const updatedUser = await updateCurrentUser(user, body)
    sendJson(res, 200, { user: updatedUser, githubConfigured: isGithubConfigured() })
    return
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    await logout(req, res)
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === '/api/manager-notes' && req.method === 'GET') {
    const user = await requireCurrentUser(req)
    const notes = await listManagerNotes(user)
    sendJson(res, 200, notes)
    return
  }

  if (url.pathname === '/api/manager-notes' && req.method === 'PUT') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const notes = await saveManagerNotes(user, body)
    sendJson(res, 200, notes)
    return
  }

  if (url.pathname === '/api/cards' && req.method === 'GET') {
    const rows = await listCards()
    sendJson(res, 200, { cards: rows.map(cardRowToPayload) })
    return
  }

  if (url.pathname === '/api/questions' && req.method === 'GET') {
    const questions = await listQuestions()
    sendJson(res, 200, { questions })
    return
  }

  if (url.pathname === '/api/questions' && req.method === 'POST') {
    const body = await readJson(req)
    const user = await getCurrentUser(req)
    const question = await createQuestion(body, user)
    void notifyNewQuestion(question)
    sendJson(res, 201, { question })
    return
  }

  if (url.pathname === '/api/cards' && req.method === 'POST') {
    const body = await readJson(req)
    const user = await getCurrentUser(req)
    const created = await createCard(body, user)
    void notifyNewCard(cardRowToPayload(created))
    sendJson(res, 201, { card: cardRowToPayload(created) })
    return
  }

  const answerMatch = url.pathname.match(/^\/api\/questions\/([0-9a-f-]{36})\/answers$/i)
  if (answerMatch && req.method === 'POST') {
    const body = await readJson(req)
    const user = await getCurrentUser(req)
    const answer = await createAnswer(answerMatch[1], body, user)
    sendJson(res, 201, { answer })
    return
  }

  const cardMatch = url.pathname.match(/^\/api\/cards\/([0-9a-f-]{36})$/i)
  if (cardMatch && req.method === 'PATCH') {
    const body = await readJson(req)
    const updated = await updateCard(cardMatch[1], body)
    if (!updated) {
      sendJson(res, 404, { error: 'Card not found.' })
      return
    }
    sendJson(res, 200, { card: cardRowToPayload(updated) })
    return
  }

  sendJson(res, 404, { error: 'Not found.' })
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/auth/github/start' && req.method === 'GET') {
    startGithubLogin(req, res)
    return
  }

  if (url.pathname === '/auth/github/callback' && req.method === 'GET') {
    await finishGithubLogin(req, res, url)
    return
  }

  sendJson(res, 404, { error: 'Not found.' })
}

async function ensureSchema() {
  await sql`create extension if not exists pgcrypto`

  await sql`
    create table if not exists cardboard_school_years (
      id uuid primary key default gen_random_uuid(),
      label text not null unique,
      starts_on date,
      ends_on date,
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create table if not exists cardboard_classrooms (
      id uuid primary key default gen_random_uuid(),
      school_year_id uuid not null references cardboard_school_years(id) on delete restrict,
      name text not null,
      join_code text not null unique,
      archived boolean not null default false,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create table if not exists cardboard_students (
      id uuid primary key default gen_random_uuid(),
      display_name text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create table if not exists cardboard_classroom_students (
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      student_id uuid not null references cardboard_students(id) on delete cascade,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      primary key (classroom_id, student_id)
    )
  `

  await sql`
    create table if not exists cardboard_users (
      id uuid primary key default gen_random_uuid(),
      github_id text not null unique,
      github_login text not null,
      display_name text not null,
      email text,
      avatar_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `

  await sql`
    create table if not exists cardboard_sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references cardboard_users(id) on delete cascade,
      token_hash text not null unique,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create index if not exists cardboard_sessions_user_expires_idx
      on cardboard_sessions (user_id, expires_at)
  `

  await sql`
    create table if not exists cardboard_cards (
      id uuid primary key default gen_random_uuid(),
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      student_id uuid references cardboard_students(id) on delete set null,
      created_by_user_id uuid references cardboard_users(id) on delete set null,
      title text not null,
      description text not null default '',
      assignee text not null default 'Unassigned',
      due_date date,
      tags text[] not null default '{}',
      team text not null default 'team1' check (team in ('team1', 'team2')),
      status text not null default 'started' check (status in ('started', 'flowing', 'done')),
      order_index integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `

  await sql`
    alter table cardboard_cards
      add column if not exists created_by_user_id uuid references cardboard_users(id) on delete set null
  `

  await sql`
    create table if not exists cardboard_card_notes (
      user_id uuid not null references cardboard_users(id) on delete cascade,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      manager_id text not null check (manager_id in ('manager1', 'manager2')),
      card_id uuid not null references cardboard_cards(id) on delete cascade,
      note_text text not null default '',
      updated_at timestamptz not null default now(),
      primary key (user_id, classroom_id, manager_id, card_id)
    )
  `

  await sql`
    create table if not exists cardboard_scratch_notes (
      user_id uuid not null references cardboard_users(id) on delete cascade,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      manager_id text not null check (manager_id in ('manager1', 'manager2')),
      html text not null default '',
      updated_at timestamptz not null default now(),
      primary key (user_id, classroom_id, manager_id)
    )
  `

  await sql`
    create table if not exists cardboard_questions (
      id uuid primary key default gen_random_uuid(),
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      question text not null,
      author text not null default 'Anonymous',
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create table if not exists cardboard_answers (
      id uuid primary key default gen_random_uuid(),
      question_id uuid not null references cardboard_questions(id) on delete cascade,
      text text not null,
      author text not null default 'Anonymous',
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create index if not exists cardboard_cards_classroom_order_idx
      on cardboard_cards (classroom_id, order_index, created_at)
  `

  const schoolYearLabel = process.env.CARDBOARD_SCHOOL_YEAR_LABEL ?? '2026-2027'
  const classroomName = process.env.CARDBOARD_CLASSROOM_NAME ?? 'Cardboard Classroom'
  const joinCode = process.env.CARDBOARD_JOIN_CODE ?? 'CARDBOARD'

  const [schoolYear] = await sql`
    insert into cardboard_school_years (label, active)
    values (${schoolYearLabel}, true)
    on conflict (label) do update set active = excluded.active
    returning id, label;
  `

  const [classroom] = await sql`
    insert into cardboard_classrooms (school_year_id, name, join_code, archived)
    values (${schoolYear.id}, ${classroomName}, ${joinCode}, false)
    on conflict (join_code) do update
      set school_year_id = excluded.school_year_id,
          name = excluded.name,
          archived = false
    returning id, name, join_code;
  `

  return classroom
}

async function listCards() {
  return sql`
    select id, title, description, assignee, due_date, tags, team, status, order_index
    from cardboard_cards
    where classroom_id = ${activeClassroom.id}
    order by order_index asc, created_at asc;
  `
}

async function createCard(body, user) {
  const title = normalizeText(body.title)
  if (!title) throw new HttpError(400, 'Title is required.')

  const [created] = await sql`
    insert into cardboard_cards (
      classroom_id, created_by_user_id, title, description, assignee, due_date, tags, team, status, order_index
    )
    values (
      ${activeClassroom.id},
      ${user?.id ?? null},
      ${title},
      ${normalizeText(body.description)},
      ${user?.displayName || normalizeText(body.assignee) || 'Unassigned'},
      ${normalizeDate(body.dueDate)},
      ${normalizeTags(body.tags)},
      ${normalizeTeam(body.team)},
      ${normalizeStatus(body.cardStatus)},
      ${(await listCards()).length}
    )
    returning id, title, description, assignee, due_date, tags, team, status, order_index;
  `

  return created
}

async function listQuestions() {
  const questionRows = await sql`
    select id, question, author, created_at
    from cardboard_questions
    where classroom_id = ${activeClassroom.id}
    order by created_at desc
  `
  const answerRows = await sql`
    select a.id, a.question_id, a.text, a.author, a.created_at
    from cardboard_answers a
    join cardboard_questions q on q.id = a.question_id
    where q.classroom_id = ${activeClassroom.id}
    order by a.created_at asc
  `
  const answersByQuestion = answerRows.reduce((acc, row) => {
    const answers = acc[row.question_id] ?? []
    return {
      ...acc,
      [row.question_id]: [
        ...answers,
        {
          id: row.id,
          text: row.text,
          author: row.author,
        },
      ],
    }
  }, {})

  return questionRows.map((row) => ({
    id: row.id,
    question: row.question,
    author: row.author,
    answers: answersByQuestion[row.id] ?? [],
  }))
}

async function createQuestion(body, user) {
  const question = normalizeText(body.question).slice(0, 2000)
  if (!question) throw new HttpError(400, 'Question is required.')

  const [created] = await sql`
    insert into cardboard_questions (classroom_id, question, author)
    values (${activeClassroom.id}, ${question}, ${user?.displayName || 'Anonymous'})
    returning id, question, author
  `

  return {
    id: created.id,
    question: created.question,
    author: created.author,
    answers: [],
  }
}

async function createAnswer(questionId, body, user) {
  const text = normalizeText(body.text).slice(0, 2000)
  if (!text) throw new HttpError(400, 'Answer is required.')

  const [question] = await sql`
    select id
    from cardboard_questions
    where id = ${questionId}
      and classroom_id = ${activeClassroom.id}
    limit 1
  `
  if (!question) throw new HttpError(404, 'Question not found.')

  const [created] = await sql`
    insert into cardboard_answers (question_id, text, author)
    values (${questionId}, ${text}, ${user?.displayName || 'Anonymous'})
    returning id, text, author
  `

  return {
    id: created.id,
    text: created.text,
    author: created.author,
  }
}

async function notifyNewCard(card) {
  await sendSlackMessage({
    text: `New card from ${card.assignee}: ${card.title}`,
    blocks: [
      sectionBlock(`*New card*\\n*${escapeSlack(card.title)}*`),
      sectionBlock(`Owner: ${escapeSlack(card.assignee)}\\nTeam: ${escapeSlack(card.team)}\\nDue: ${escapeSlack(card.dueDate || 'No date')}`),
      ...(card.description ? [sectionBlock(escapeSlack(card.description))] : []),
    ],
  })
}

async function notifyNewQuestion(question) {
  await sendSlackMessage({
    text: `New Q&A question from ${question.author}: ${question.question}`,
    blocks: [
      sectionBlock(`*New Q&A question*\\n*${escapeSlack(question.question)}*`),
      sectionBlock(`Asked by: ${escapeSlack(question.author)}`),
    ],
  })
}

async function sendSlackMessage(payload) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      console.warn(`Slack notification failed: ${response.status} ${await response.text()}`)
    }
  } catch (error) {
    console.warn('Slack notification failed:', error)
  }
}

function sectionBlock(text) {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text,
    },
  }
}

function escapeSlack(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function updateCard(id, body) {
  const title = normalizeText(body.title)
  if (!title) throw new HttpError(400, 'Title is required.')

  const [updated] = await sql`
    update cardboard_cards
    set title = ${title},
        description = ${normalizeText(body.description)},
        assignee = ${normalizeText(body.assignee) || 'Unassigned'},
        due_date = ${normalizeDate(body.dueDate)},
        tags = ${normalizeTags(body.tags)},
        team = ${normalizeTeam(body.team)},
        status = ${normalizeStatus(body.cardStatus)},
        updated_at = now()
    where id = ${id}
      and classroom_id = ${activeClassroom.id}
    returning id, title, description, assignee, due_date, tags, team, status, order_index;
  `

  return updated ?? null
}

async function listManagerNotes(user) {
  const cardRows = await sql`
    select manager_id, card_id, note_text
    from cardboard_card_notes
    where user_id = ${user.id}
      and classroom_id = ${activeClassroom.id}
  `
  const scratchRows = await sql`
    select manager_id, html
    from cardboard_scratch_notes
    where user_id = ${user.id}
      and classroom_id = ${activeClassroom.id}
  `

  return {
    notes: cardRows.reduce(
      (acc, row) => ({
        ...acc,
        [row.manager_id]: {
          ...acc[row.manager_id],
          [row.card_id]: row.note_text ?? '',
        },
      }),
      { manager1: {}, manager2: {} },
    ),
    scratchNotes: scratchRows.reduce(
      (acc, row) => ({ ...acc, [row.manager_id]: sanitizeNoteHtml(row.html ?? '') }),
      { manager1: '', manager2: '' },
    ),
  }
}

async function saveManagerNotes(user, body) {
  const notes = normalizeManagerNotes(body.notes)
  const scratchNotes = normalizeScratchNotes(body.scratchNotes)

  for (const managerId of ['manager1', 'manager2']) {
    for (const [cardId, noteText] of Object.entries(notes[managerId])) {
      await sql`
        insert into cardboard_card_notes (
          user_id, classroom_id, manager_id, card_id, note_text, updated_at
        )
        values (
          ${user.id}, ${activeClassroom.id}, ${managerId}, ${cardId}, ${noteText}, now()
        )
        on conflict (user_id, classroom_id, manager_id, card_id) do update
          set note_text = excluded.note_text,
              updated_at = now()
      `
    }

    await sql`
      insert into cardboard_scratch_notes (
        user_id, classroom_id, manager_id, html, updated_at
      )
      values (
        ${user.id}, ${activeClassroom.id}, ${managerId}, ${scratchNotes[managerId]}, now()
      )
      on conflict (user_id, classroom_id, manager_id) do update
        set html = excluded.html,
            updated_at = now()
    `
  }

  return listManagerNotes(user)
}

function startGithubLogin(req, res) {
  if (!isGithubConfigured()) {
    redirect(res, '/?auth_error=github_not_configured')
    return
  }

  const state = randomToken()
  const redirectUri = `${requestOrigin(req)}/auth/github/callback`
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
  })

  setCookie(res, 'cardboard_oauth_state', state, { maxAge: 600 })
  redirect(res, `https://github.com/login/oauth/authorize?${params}`)
}

async function finishGithubLogin(req, res, url) {
  const expectedState = parseCookies(req.headers.cookie).cardboard_oauth_state
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')

  if (!expectedState || !state || state !== expectedState || !code) {
    clearCookie(res, 'cardboard_oauth_state')
    redirect(res, '/?auth_error=github_state')
    return
  }

  const redirectUri = `${requestOrigin(req)}/auth/github/callback`
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const tokenData = await tokenResponse.json()

  if (!tokenResponse.ok || !tokenData.access_token) {
    clearCookie(res, 'cardboard_oauth_state')
    redirect(res, '/?auth_error=github_token')
    return
  }

  const githubUser = await fetchGithubJson('https://api.github.com/user', tokenData.access_token)
  const githubEmails = await fetchGithubJson('https://api.github.com/user/emails', tokenData.access_token).catch(() => [])
  const email = Array.isArray(githubEmails)
    ? githubEmails.find((item) => item.primary && item.verified)?.email ?? githubUser.email ?? null
    : githubUser.email ?? null

  const [user] = await sql`
    insert into cardboard_users (
      github_id, github_login, display_name, email, avatar_url, updated_at
    )
    values (
      ${String(githubUser.id)},
      ${githubUser.login},
      ${githubUser.name || githubUser.login},
      ${email},
      ${githubUser.avatar_url ?? null},
      now()
    )
    on conflict (github_id) do update
      set github_login = excluded.github_login,
          display_name = excluded.display_name,
          email = excluded.email,
          avatar_url = excluded.avatar_url,
          updated_at = now()
    returning id;
  `

  const sessionToken = randomToken()
  await sql`
    insert into cardboard_sessions (user_id, token_hash, expires_at)
    values (${user.id}, ${hashToken(sessionToken)}, now() + interval '30 days')
  `

  clearCookie(res, 'cardboard_oauth_state')
  setCookie(res, 'cardboard_session', sessionToken, { maxAge: 60 * 60 * 24 * 30 })
  redirect(res, '/')
}

async function fetchGithubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cardboard-standup-app',
    },
  })

  if (!response.ok) {
    throw new HttpError(502, 'GitHub account lookup failed.')
  }

  return response.json()
}

async function getCurrentUser(req) {
  const sessionToken = parseCookies(req.headers.cookie).cardboard_session
  if (!sessionToken) return null

  const [user] = await sql`
    select u.id, u.github_login, u.display_name, u.email, u.avatar_url
    from cardboard_sessions s
    join cardboard_users u on u.id = s.user_id
    where s.token_hash = ${hashToken(sessionToken)}
      and s.expires_at > now()
    limit 1
  `

  if (!user) return null

  return {
    id: user.id,
    githubLogin: user.github_login,
    displayName: user.display_name,
    email: user.email,
    avatarUrl: user.avatar_url,
  }
}

async function updateCurrentUser(user, body) {
  const displayName = normalizeText(body.displayName).slice(0, 80)
  if (!displayName) throw new HttpError(400, 'Default name is required.')

  const [updated] = await sql`
    update cardboard_users
    set display_name = ${displayName},
        updated_at = now()
    where id = ${user.id}
    returning id, github_login, display_name, email, avatar_url
  `

  return {
    id: updated.id,
    githubLogin: updated.github_login,
    displayName: updated.display_name,
    email: updated.email,
    avatarUrl: updated.avatar_url,
  }
}

async function requireCurrentUser(req) {
  const user = await getCurrentUser(req)
  if (!user) throw new HttpError(401, 'Sign in to save notes.')
  return user
}

async function logout(req, res) {
  const sessionToken = parseCookies(req.headers.cookie).cardboard_session
  if (sessionToken) {
    await sql`delete from cardboard_sessions where token_hash = ${hashToken(sessionToken)}`
  }
  clearCookie(res, 'cardboard_session')
}

function cardRowToPayload(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    assignee: row.assignee ?? 'Unassigned',
    dueDate: formatDate(row.due_date),
    tags: Array.isArray(row.tags) ? row.tags : [],
    team: row.team === 'team2' ? 'team2' : 'team1',
    cardStatus: row.status === 'flowing' || row.status === 'done' ? row.status : 'started',
  }
}

function formatDate(value) {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}

  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Invalid JSON.')
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function redirect(res, location) {
  res.writeHead(302, { location })
  res.end()
}

function requestOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] ?? 'http'
  return `${protocol}://${req.headers.host ?? `localhost:${port}`}`
}

function isGithubConfigured() {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        if (index === -1) return [part, '']
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
      }),
  )
}

function setCookie(res, name, value, options = {}) {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge ?? 0}`,
  ]

  if (process.env.NODE_ENV === 'production') cookie.push('Secure')
  appendSetCookie(res, cookie.join('; '))
}

function clearCookie(res, name) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('set-cookie')
  if (!existing) {
    res.setHeader('set-cookie', value)
    return
  }
  res.setHeader('set-cookie', Array.isArray(existing) ? [...existing, value] : [existing, value])
}

function randomToken() {
  return randomBytes(32).toString('base64url')
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function serveStatic(pathname, res) {
  const dist = resolve('dist')
  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const filePath = resolve(join(dist, requestedPath))
  const safePath = filePath.startsWith(dist) && existsSync(filePath) ? filePath : join(dist, 'index.html')
  const type = mimeType(extname(safePath))

  res.writeHead(200, { 'content-type': type })
  createReadStream(safePath).pipe(res)
}

function mimeType(extension) {
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[extension] ?? 'application/octet-stream'
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function normalizeTags(value) {
  return Array.isArray(value) ? value.map(normalizeText).filter(Boolean) : []
}

function normalizeManagerNotes(value) {
  return {
    manager1: normalizeCardNoteMap(value?.manager1),
    manager2: normalizeCardNoteMap(value?.manager2),
  }
}

function normalizeCardNoteMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([cardId]) => /^[0-9a-f-]{36}$/i.test(cardId))
      .map(([cardId, noteText]) => [cardId, normalizeText(noteText).slice(0, 5000)]),
  )
}

function normalizeScratchNotes(value) {
  return {
    manager1: sanitizeNoteHtml(value?.manager1 ?? ''),
    manager2: sanitizeNoteHtml(value?.manager2 ?? ''),
  }
}

function sanitizeNoteHtml(value) {
  const text = typeof value === 'string' ? value.slice(0, 20000) : ''
  return text
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/\s(?:style|class|id)="[^"]*"/gi, '')
    .replace(/\s(?:style|class|id)='[^']*'/gi, '')
    .replace(/<(\/?)(?!strong\b|b\b|em\b|i\b|u\b|br\b|div\b|p\b)([a-z][^>]*)>/gi, '')
}

function normalizeTeam(value) {
  return value === 'team2' ? 'team2' : 'team1'
}

function normalizeStatus(value) {
  return value === 'flowing' || value === 'done' ? value : 'started'
}

function loadEnv() {
  if (!existsSync('.env')) return

  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/)
    if (!match) continue

    const key = match[1]
    let value = match[2] ?? ''
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] ??= value
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
