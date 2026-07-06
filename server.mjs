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

  if (url.pathname === '/api/roster' && req.method === 'GET') {
    await requireCurrentUser(req)
    const users = await listRoster()
    sendJson(res, 200, { users })
    return
  }

  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    await requireAdmin(req)
    const users = await listRoster()
    sendJson(res, 200, { users })
    return
  }

  const adminMembershipsMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/memberships$/i)
  if (adminMembershipsMatch && req.method === 'PUT') {
    await requireAdmin(req)
    const body = await readJson(req)
    const updated = await updateUserMemberships(adminMembershipsMatch[1], body)
    if (!updated) {
      sendJson(res, 404, { error: 'User not found.' })
      return
    }
    sendJson(res, 200, { user: updated })
    return
  }

  if (url.pathname === '/api/pm-notes' && req.method === 'GET') {
    const user = await requireCurrentUser(req)
    const team = resolvePmNotesTeam(user, url.searchParams.get('team'))
    const notes = await listPmNotes(user, team)
    sendJson(res, 200, notes)
    return
  }

  if (url.pathname === '/api/pm-notes' && req.method === 'PUT') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const team = resolvePmNotesTeam(user, body.team)
    const notes = await savePmNotes(user, team, body)
    sendJson(res, 200, notes)
    return
  }

  if (url.pathname === '/api/cards' && req.method === 'GET') {
    await requireCurrentUser(req)
    const rows = await listCards()
    sendJson(res, 200, { cards: rows.map(cardRowToPayload) })
    return
  }

  if (url.pathname === '/api/questions' && req.method === 'GET') {
    await requireCurrentUser(req)
    const questions = await listQuestions()
    sendJson(res, 200, { questions })
    return
  }

  if (url.pathname === '/api/questions' && req.method === 'POST') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const question = await createQuestion(body, user)
    void notifyNewQuestion(question)
    sendJson(res, 201, { question })
    return
  }

  if (url.pathname === '/api/cards' && req.method === 'POST') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const created = await createCard(body, user)
    await recordCardEvent(created.id, user.id, 'created', null, null, null)
    void notifyNewCard(cardRowToPayload(created))
    sendJson(res, 201, { card: cardRowToPayload(created) })
    return
  }

  const answerMatch = url.pathname.match(/^\/api\/questions\/([0-9a-f-]{36})\/answers$/i)
  if (answerMatch && req.method === 'POST') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const answer = await createAnswer(answerMatch[1], body, user)
    sendJson(res, 201, { answer })
    return
  }

  const cardEventsMatch = url.pathname.match(/^\/api\/cards\/([0-9a-f-]{36})\/events$/i)
  if (cardEventsMatch && req.method === 'GET') {
    await requireCurrentUser(req)
    const events = await listCardEvents(cardEventsMatch[1])
    sendJson(res, 200, { events })
    return
  }

  const teamActivityMatch = url.pathname.match(/^\/api\/teams\/([a-z0-9][a-z0-9-]*)\/activity$/)
  if (teamActivityMatch && req.method === 'GET') {
    const team = teamActivityMatch[1]
    const user = await requireCurrentUser(req)
    if (!(await isKnownTeam(team))) {
      sendJson(res, 404, { error: 'Team not found.' })
      return
    }
    requireTeamPmOrAdmin(user, team)
    const events = await listTeamActivity(team)
    sendJson(res, 200, { events })
    return
  }

  const cardCommentsMatch = url.pathname.match(/^\/api\/cards\/([0-9a-f-]{36})\/comments$/i)
  if (cardCommentsMatch && req.method === 'GET') {
    await requireCurrentUser(req)
    const comments = await listCardComments(cardCommentsMatch[1])
    sendJson(res, 200, { comments })
    return
  }

  if (cardCommentsMatch && req.method === 'POST') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const comment = await createCardComment(cardCommentsMatch[1], body, user)
    sendJson(res, 201, { comment })
    return
  }

  const cardMatch = url.pathname.match(/^\/api\/cards\/([0-9a-f-]{36})$/i)
  if (cardMatch && req.method === 'PATCH') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const updated = await updateCard(cardMatch[1], body, user)
    if (!updated) {
      sendJson(res, 404, { error: 'Card not found.' })
      return
    }
    sendJson(res, 200, { card: cardRowToPayload(updated) })
    return
  }

  // Check-ins: a PM's dated 1:1 notes + goals about each student on their
  // team. Writable by that team's PM or an admin; a student can additionally
  // read (never edit) the entries that are about them.

  if (url.pathname === '/api/checkins/mine' && req.method === 'GET') {
    const user = await requireCurrentUser(req)
    const checkins = await listCheckins({ subjectUserId: user.id })
    sendJson(res, 200, { checkins })
    return
  }

  const teamCheckinsMatch = url.pathname.match(/^\/api\/teams\/([a-z0-9][a-z0-9-]*)\/checkins$/)
  if (teamCheckinsMatch && req.method === 'GET') {
    const user = await requireCurrentUser(req)
    if (!(await isKnownTeam(teamCheckinsMatch[1]))) {
      sendJson(res, 404, { error: 'Team not found.' })
      return
    }
    requireTeamPmOrAdmin(user, teamCheckinsMatch[1])
    const checkins = await listCheckins({ team: teamCheckinsMatch[1] })
    sendJson(res, 200, { checkins })
    return
  }

  if (url.pathname === '/api/teams' && req.method === 'GET') {
    await requireCurrentUser(req)
    const [teams, projects] = await Promise.all([getTeams(), getProjects()])
    sendJson(res, 200, { teams: teams.map(teamRowToPayload), projects: projects.map(projectRowToPayload) })
    return
  }

  if (url.pathname === '/api/projects' && req.method === 'POST') {
    await requireAdmin(req)
    const body = await readJson(req)
    const project = await createProject(body)
    sendJson(res, 201, { project })
    return
  }

  const projectPatchMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]*)$/)
  if (projectPatchMatch && req.method === 'PATCH') {
    await requireAdmin(req)
    const body = await readJson(req)
    const project = await updateProject(projectPatchMatch[1], body)
    if (!project) {
      sendJson(res, 404, { error: 'Project not found.' })
      return
    }
    sendJson(res, 200, { project })
    return
  }

  if (url.pathname === '/api/teams' && req.method === 'POST') {
    await requireAdmin(req)
    const body = await readJson(req)
    const team = await createTeam(body)
    sendJson(res, 201, { team })
    return
  }

  const teamPatchMatch = url.pathname.match(/^\/api\/teams\/([a-z0-9][a-z0-9-]*)$/)
  if (teamPatchMatch && req.method === 'PATCH') {
    await requireAdmin(req)
    const body = await readJson(req)
    const team = await updateTeam(teamPatchMatch[1], body)
    if (!team) {
      sendJson(res, 404, { error: 'Team not found.' })
      return
    }
    sendJson(res, 200, { team })
    return
  }

  if (url.pathname === '/api/checkins' && req.method === 'POST') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const checkin = await createCheckin(body, user)
    sendJson(res, 201, { checkin })
    return
  }

  const checkinMatch = url.pathname.match(/^\/api\/checkins\/([0-9a-f-]{36})$/i)
  if (checkinMatch && req.method === 'PATCH') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const checkin = await updateCheckinNotes(checkinMatch[1], body, user)
    if (!checkin) {
      sendJson(res, 404, { error: 'Check-in not found.' })
      return
    }
    sendJson(res, 200, { checkin })
    return
  }

  const checkinGoalMatch = url.pathname.match(/^\/api\/checkin-goals\/([0-9a-f-]{36})$/i)
  if (checkinGoalMatch && req.method === 'PATCH') {
    const user = await requireCurrentUser(req)
    const body = await readJson(req)
    const goal = await updateCheckinGoal(checkinGoalMatch[1], body, user)
    if (!goal) {
      sendJson(res, 404, { error: 'Goal not found.' })
      return
    }
    sendJson(res, 200, { goal })
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
    alter table cardboard_users
      add column if not exists role text not null default 'student' check (role in ('student', 'pm'))
  `

  await sql`
    alter table cardboard_users
      add column if not exists team text check (team in ('team1', 'team2'))
  `

  await sql`
    create index if not exists cardboard_users_role_team_idx
      on cardboard_users (role, team)
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
    alter table cardboard_cards
      add column if not exists assignee_user_id uuid references cardboard_users(id) on delete set null
  `

  await sql`
    create index if not exists cardboard_cards_assignee_idx
      on cardboard_cards (assignee_user_id)
  `

  await sql`
    alter table cardboard_cards
      add column if not exists priority text not null default 'medium' check (priority in ('low', 'medium', 'high'))
  `

  await sql`
    create table if not exists cardboard_card_events (
      id uuid primary key default gen_random_uuid(),
      card_id uuid not null references cardboard_cards(id) on delete cascade,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      actor_user_id uuid not null references cardboard_users(id) on delete set null,
      event_type text not null check (event_type in ('created', 'status_changed', 'assignee_changed', 'priority_changed', 'edited')),
      field text,
      old_value text,
      new_value text,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create index if not exists cardboard_card_events_card_idx
      on cardboard_card_events (card_id, created_at)
  `

  await sql`
    alter table cardboard_card_events
      drop constraint if exists cardboard_card_events_event_type_check
  `

  await sql`
    alter table cardboard_card_events
      add constraint cardboard_card_events_event_type_check
      check (event_type in ('created', 'status_changed', 'assignee_changed', 'priority_changed', 'edited'))
  `

  await sql`
    create table if not exists cardboard_card_comments (
      id uuid primary key default gen_random_uuid(),
      card_id uuid not null references cardboard_cards(id) on delete cascade,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      author_user_id uuid not null references cardboard_users(id) on delete set null,
      parent_comment_id uuid references cardboard_card_comments(id) on delete cascade,
      body text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `

  await sql`
    create index if not exists cardboard_card_comments_card_idx
      on cardboard_card_comments (card_id, created_at)
  `

  await sql`
    create table if not exists cardboard_card_notes (
      user_id uuid not null references cardboard_users(id) on delete cascade,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      team text not null check (team in ('team1', 'team2')),
      card_id uuid not null references cardboard_cards(id) on delete cascade,
      note_text text not null default '',
      updated_at timestamptz not null default now(),
      primary key (user_id, classroom_id, team, card_id)
    )
  `

  await sql`
    create table if not exists cardboard_scratch_notes (
      user_id uuid not null references cardboard_users(id) on delete cascade,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      team text not null check (team in ('team1', 'team2')),
      html text not null default '',
      updated_at timestamptz not null default now(),
      primary key (user_id, classroom_id, team)
    )
  `

  await sql`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'cardboard_card_notes' and column_name = 'manager_id'
      ) then
        alter table cardboard_card_notes rename column manager_id to team;
        alter table cardboard_card_notes drop constraint if exists cardboard_card_notes_manager_id_check;
        update cardboard_card_notes set team = case when team = 'manager1' then 'team1' else 'team2' end;
        alter table cardboard_card_notes add constraint cardboard_card_notes_team_check check (team in ('team1', 'team2'));
      end if;
    end $$;
  `

  await sql`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_name = 'cardboard_scratch_notes' and column_name = 'manager_id'
      ) then
        alter table cardboard_scratch_notes rename column manager_id to team;
        alter table cardboard_scratch_notes drop constraint if exists cardboard_scratch_notes_manager_id_check;
        update cardboard_scratch_notes set team = case when team = 'manager1' then 'team1' else 'team2' end;
        alter table cardboard_scratch_notes add constraint cardboard_scratch_notes_team_check check (team in ('team1', 'team2'));
      end if;
    end $$;
  `

  await sql`
    create table if not exists cardboard_checkins (
      id uuid primary key default gen_random_uuid(),
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      team text not null check (team in ('team1', 'team2')),
      subject_user_id uuid not null references cardboard_users(id) on delete cascade,
      author_user_id uuid references cardboard_users(id) on delete set null,
      checkin_date date not null default current_date,
      notes text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `

  await sql`
    create index if not exists cardboard_checkins_subject_idx
      on cardboard_checkins (subject_user_id, created_at desc)
  `

  await sql`
    create index if not exists cardboard_checkins_team_idx
      on cardboard_checkins (classroom_id, team, created_at desc)
  `

  await sql`
    create table if not exists cardboard_checkin_goals (
      id uuid primary key default gen_random_uuid(),
      checkin_id uuid not null references cardboard_checkins(id) on delete cascade,
      goal_text text not null,
      status text not null default 'pending' check (status in ('pending', 'met', 'missed')),
      order_index integer not null default 0,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create index if not exists cardboard_checkin_goals_checkin_idx
      on cardboard_checkin_goals (checkin_id, order_index)
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

  // Teams are dynamic rows now, not a hardcoded team1/team2 pair. The legacy
  // check constraints have to go so new slugs can exist; values are validated
  // in app code against cardboard_teams instead.
  await sql`
    create table if not exists cardboard_teams (
      slug text primary key,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      name text not null,
      archived boolean not null default false,
      order_index integer not null default 0,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    create table if not exists cardboard_projects (
      slug text primary key,
      classroom_id uuid not null references cardboard_classrooms(id) on delete cascade,
      name text not null,
      archived boolean not null default false,
      order_index integer not null default 0,
      created_at timestamptz not null default now()
    )
  `

  await sql`
    alter table cardboard_teams
      add column if not exists project_slug text references cardboard_projects(slug)
  `

  // A user can belong to several teams, with a role per team ("PM of Team 2,
  // plain member of Dixie Tech App"). Replaces the single role/team pair on
  // cardboard_users.
  await sql`
    create table if not exists cardboard_team_members (
      user_id uuid not null references cardboard_users(id) on delete cascade,
      team_slug text not null references cardboard_teams(slug) on update cascade on delete cascade,
      role text not null default 'member' check (role in ('member', 'pm')),
      created_at timestamptz not null default now(),
      primary key (user_id, team_slug)
    )
  `

  await sql`
    create index if not exists cardboard_team_members_team_idx
      on cardboard_team_members (team_slug, role)
  `

  await sql`alter table cardboard_users drop constraint if exists cardboard_users_team_check`
  await sql`alter table cardboard_cards drop constraint if exists cardboard_cards_team_check`
  await sql`alter table cardboard_card_notes drop constraint if exists cardboard_card_notes_team_check`
  await sql`alter table cardboard_scratch_notes drop constraint if exists cardboard_scratch_notes_team_check`
  await sql`alter table cardboard_checkins drop constraint if exists cardboard_checkins_team_check`

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

  // Seed the legacy pair so existing team1/team2 data keeps resolving, and
  // group any project-less teams under the class's "Stand-Up" project.
  await sql`
    insert into cardboard_projects (slug, classroom_id, name, order_index)
    values ('stand-up', ${classroom.id}, 'Stand-Up', 0)
    on conflict (slug) do nothing
  `

  await sql`
    insert into cardboard_teams (slug, classroom_id, name, order_index, project_slug)
    values ('team1', ${classroom.id}, 'Team 1', 0, 'stand-up'), ('team2', ${classroom.id}, 'Team 2', 1, 'stand-up')
    on conflict (slug) do nothing
  `

  await sql`
    update cardboard_teams set project_slug = 'stand-up' where project_slug is null
  `

  // One-time migration of the legacy single role/team pair into memberships.
  // Clearing the legacy columns afterwards makes this a no-op on later boots,
  // so removed memberships don't resurrect.
  await sql`
    insert into cardboard_team_members (user_id, team_slug, role)
    select id, team, case when role = 'pm' then 'pm' else 'member' end
    from cardboard_users
    where team is not null and team in (select slug from cardboard_teams)
    on conflict (user_id, team_slug) do nothing
  `

  await sql`
    update cardboard_users set team = null, role = 'student' where team is not null
  `

  return classroom
}

async function listCards() {
  return sql`
    select id, title, description, assignee, assignee_user_id, due_date, tags, team, status, priority, order_index
    from cardboard_cards
    where classroom_id = ${activeClassroom.id}
    order by order_index asc, created_at asc;
  `
}

// Resolves a client-supplied assignee id to a real cardboard_users.id, or null
// (unassigned) if absent/invalid. Never trusts the id without checking it exists.
async function resolveAssigneeUserId(candidateId) {
  if (!candidateId) return null
  const [match] = await sql`select id from cardboard_users where id = ${candidateId} limit 1`
  return match ? match.id : null
}

async function createCard(body, user) {
  const title = normalizeText(body.title)
  if (!title) throw new HttpError(400, 'Title is required.')

  // The create form sends the picker's choice (a user id, or null for Unassigned);
  // a request without the key at all still defaults to the creator.
  const assigneeUserId = 'assigneeUserId' in body ? await resolveAssigneeUserId(body.assigneeUserId) : user.id
  const [assignee] = await sql`select display_name from cardboard_users where id = ${assigneeUserId} limit 1`
  const team = await resolveTeamSlug(body.team)

  const [created] = await sql`
    insert into cardboard_cards (
      classroom_id, created_by_user_id, title, description, assignee, assignee_user_id, due_date, tags, team, status, priority, order_index
    )
    values (
      ${activeClassroom.id},
      ${user.id},
      ${title},
      ${normalizeText(body.description)},
      ${assignee?.display_name ?? 'Unassigned'},
      ${assigneeUserId},
      ${normalizeDate(body.dueDate)},
      ${normalizeTags(body.tags)},
      ${team},
      ${normalizeStatus(body.cardStatus)},
      ${normalizePriority(body.priority)},
      ${(await listCards()).length}
    )
    returning id, title, description, assignee, assignee_user_id, due_date, tags, team, status, priority, order_index;
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
    values (${activeClassroom.id}, ${question}, ${user.displayName})
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
    values (${questionId}, ${text}, ${user.displayName})
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

async function updateCard(id, body, user) {
  const title = normalizeText(body.title)
  if (!title) throw new HttpError(400, 'Title is required.')

  const [before] = await sql`
    select id, title, description, assignee, assignee_user_id, due_date, tags, team, status, priority
    from cardboard_cards
    where id = ${id} and classroom_id = ${activeClassroom.id}
    limit 1
  `
  if (!before) return null

  const nextStatus = normalizeStatus(body.cardStatus)
  const nextPriority = normalizePriority(body.priority)
  // The edit form always sends the full assignee choice (a real id or null for
  // "Unassigned") — no fallback to the previous value, unlike creation's default-to-creator.
  const nextAssigneeUserId = await resolveAssigneeUserId(body.assigneeUserId)
  const [assignee] = nextAssigneeUserId
    ? await sql`select display_name from cardboard_users where id = ${nextAssigneeUserId} limit 1`
    : [null]
  const nextAssigneeName = assignee?.display_name ?? 'Unassigned'
  const nextDueDate = normalizeDate(body.dueDate)
  const nextTags = normalizeTags(body.tags)
  const nextTeam = await resolveTeamSlug(body.team, before.team)
  const nextDescription = normalizeText(body.description)

  const events = []
  if (before.status !== nextStatus) events.push(['status_changed', 'status', before.status, nextStatus])
  if (before.priority !== nextPriority) events.push(['priority_changed', 'priority', before.priority, nextPriority])
  if (String(before.assignee_user_id ?? '') !== String(nextAssigneeUserId ?? '')) {
    events.push(['assignee_changed', 'assignee', before.assignee, nextAssigneeName])
  }
  if (before.title !== title) events.push(['edited', 'title', before.title, title])
  if ((before.description ?? '') !== nextDescription) events.push(['edited', 'description', before.description, nextDescription])
  if (formatDate(before.due_date) !== (nextDueDate ?? '')) events.push(['edited', 'due_date', formatDate(before.due_date), nextDueDate])
  if (before.team !== nextTeam) events.push(['edited', 'team', before.team, nextTeam])

  const queries = [
    sql`
      update cardboard_cards
      set title = ${title},
          description = ${nextDescription},
          assignee = ${nextAssigneeName},
          assignee_user_id = ${nextAssigneeUserId},
          due_date = ${nextDueDate},
          tags = ${nextTags},
          team = ${nextTeam},
          status = ${nextStatus},
          priority = ${nextPriority},
          updated_at = now()
      where id = ${id}
        and classroom_id = ${activeClassroom.id}
      returning id, title, description, assignee, assignee_user_id, due_date, tags, team, status, priority, order_index
    `,
    ...events.map(([eventType, field, oldValue, newValue]) => sql`
      insert into cardboard_card_events (card_id, classroom_id, actor_user_id, event_type, field, old_value, new_value)
      values (${id}, ${activeClassroom.id}, ${user.id}, ${eventType}, ${field}, ${String(oldValue ?? '')}, ${String(newValue ?? '')})
    `),
  ]

  const results = await sql.transaction(queries)
  const [updated] = results[0]
  return updated ?? null
}

async function recordCardEvent(cardId, actorUserId, eventType, field, oldValue, newValue) {
  await sql`
    insert into cardboard_card_events (card_id, classroom_id, actor_user_id, event_type, field, old_value, new_value)
    values (${cardId}, ${activeClassroom.id}, ${actorUserId}, ${eventType}, ${field}, ${oldValue}, ${newValue})
  `
}

async function listCardEvents(cardId) {
  const rows = await sql`
    select e.id, e.event_type, e.field, e.old_value, e.new_value, e.created_at,
           u.display_name as actor_name, u.avatar_url as actor_avatar_url
    from cardboard_card_events e
    join cardboard_users u on u.id = e.actor_user_id
    where e.card_id = ${cardId}
    order by e.created_at asc
  `

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    createdAt: row.created_at,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
  }))
}

async function listTeamActivity(team, limit = 25) {
  const rows = await sql`
    select e.id, e.event_type, e.field, e.old_value, e.new_value, e.created_at,
           u.display_name as actor_name, u.avatar_url as actor_avatar_url,
           c.id as card_id, c.title as card_title
    from cardboard_card_events e
    join cardboard_users u on u.id = e.actor_user_id
    join cardboard_cards c on c.id = e.card_id
    where c.classroom_id = ${activeClassroom.id} and c.team = ${team}
    order by e.created_at desc
    limit ${limit}
  `

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    createdAt: row.created_at,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    cardId: row.card_id,
    cardTitle: row.card_title,
  }))
}

async function listCardComments(cardId) {
  const rows = await sql`
    select c.id, c.body, c.created_at, u.id as author_id, u.display_name as author_name, u.avatar_url as author_avatar_url
    from cardboard_card_comments c
    join cardboard_users u on u.id = c.author_user_id
    where c.card_id = ${cardId}
    order by c.created_at asc
  `

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
  }))
}

async function createCardComment(cardId, body, user) {
  const text = normalizeText(body.body).slice(0, 5000)
  if (!text) throw new HttpError(400, 'Comment text is required.')

  const [card] = await sql`
    select id from cardboard_cards where id = ${cardId} and classroom_id = ${activeClassroom.id} limit 1
  `
  if (!card) throw new HttpError(404, 'Card not found.')

  const [created] = await sql`
    insert into cardboard_card_comments (card_id, classroom_id, author_user_id, body)
    values (${cardId}, ${activeClassroom.id}, ${user.id}, ${text})
    returning id, body, created_at
  `

  return {
    id: created.id,
    body: created.body,
    createdAt: created.created_at,
    authorId: user.id,
    authorName: user.displayName,
    authorAvatarUrl: user.avatarUrl,
  }
}

async function listRoster() {
  const [rows, memberRows] = await Promise.all([
    sql`select id, display_name, github_login from cardboard_users order by display_name asc`,
    sql`select user_id, team_slug, role from cardboard_team_members order by created_at`,
  ])

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    githubLogin: row.github_login,
    memberships: memberRows
      .filter((m) => m.user_id === row.id)
      .map((m) => ({ team: m.team_slug, role: m.role })),
  }))
}

// Replaces a user's full membership set: [{team, role: 'member'|'pm'}, …].
async function updateUserMemberships(userId, body) {
  const [existing] = await sql`
    select id, display_name, github_login from cardboard_users where id = ${userId} limit 1
  `
  if (!existing) return null

  const raw = Array.isArray(body.memberships) ? body.memberships : []
  const seen = new Set()
  const memberships = []
  for (const entry of raw.slice(0, 30)) {
    const team = await requireTeamSlug(String(entry?.team ?? ''))
    if (seen.has(team)) continue
    seen.add(team)
    memberships.push({ team, role: entry?.role === 'pm' ? 'pm' : 'member' })
  }

  await sql.transaction([
    sql`delete from cardboard_team_members where user_id = ${userId}`,
    ...memberships.map((m) => sql`
      insert into cardboard_team_members (user_id, team_slug, role)
      values (${userId}, ${m.team}, ${m.role})
    `),
  ])

  return {
    id: existing.id,
    displayName: existing.display_name,
    githubLogin: existing.github_login,
    memberships,
  }
}

// A PM only ever reads/writes notes for a team they hold the PM role on; the
// team comes from the request so multi-team PMs can switch between them.
function resolvePmNotesTeam(user, requested) {
  const pmTeams = pmTeamsOf(user)
  if (pmTeams.length === 0) throw new HttpError(403, 'PM access required.')
  if (requested) {
    if (!pmTeams.includes(requested)) throw new HttpError(403, 'PM access required for this team.')
    return requested
  }
  return pmTeams[0]
}

async function listPmNotes(user, team) {
  const cardRows = await sql`
    select card_id, note_text
    from cardboard_card_notes
    where user_id = ${user.id}
      and classroom_id = ${activeClassroom.id}
      and team = ${team}
  `
  const [scratch] = await sql`
    select html
    from cardboard_scratch_notes
    where user_id = ${user.id}
      and classroom_id = ${activeClassroom.id}
      and team = ${team}
  `

  return {
    team,
    notes: Object.fromEntries(cardRows.map((row) => [row.card_id, row.note_text ?? ''])),
    scratchNotes: sanitizeNoteHtml(scratch?.html ?? ''),
  }
}

async function savePmNotes(user, team, body) {
  const notes = normalizeCardNoteMap(body.notes)
  const scratchHtml = sanitizeNoteHtml(body.scratchNotes ?? '')

  const noteQueries = Object.entries(notes).map(([cardId, noteText]) => sql`
    insert into cardboard_card_notes (user_id, classroom_id, team, card_id, note_text, updated_at)
    values (${user.id}, ${activeClassroom.id}, ${team}, ${cardId}, ${noteText}, now())
    on conflict (user_id, classroom_id, team, card_id) do update
      set note_text = excluded.note_text, updated_at = now()
  `)

  await sql.transaction([
    ...noteQueries,
    sql`
      insert into cardboard_scratch_notes (user_id, classroom_id, team, html, updated_at)
      values (${user.id}, ${activeClassroom.id}, ${team}, ${scratchHtml}, now())
      on conflict (user_id, classroom_id, team) do update
        set html = excluded.html, updated_at = now()
    `,
  ])

  return listPmNotes(user, team)
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

async function membershipsOf(userId) {
  const rows = await sql`
    select team_slug, role from cardboard_team_members
    where user_id = ${userId}
    order by created_at
  `
  return rows.map((row) => ({ team: row.team_slug, role: row.role }))
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

  return userRowToPayload(user, await membershipsOf(user.id))
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

  return userRowToPayload(updated, await membershipsOf(updated.id))
}

// ── Check-ins ────────────────────────────────────────────────────────────────

function pmTeamsOf(user) {
  return (user.memberships ?? []).filter((m) => m.role === 'pm').map((m) => m.team)
}

function requireTeamPmOrAdmin(user, team) {
  if (!user.isAdmin && !pmTeamsOf(user).includes(team)) {
    throw new HttpError(403, 'PM or admin access required for this team.')
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function listCheckins({ team, subjectUserId }) {
  const rows = team
    ? await sql`
        select c.*, su.display_name as subject_name, au.display_name as author_name
        from cardboard_checkins c
        join cardboard_users su on su.id = c.subject_user_id
        left join cardboard_users au on au.id = c.author_user_id
        where c.classroom_id = ${activeClassroom.id} and c.team = ${team}
        order by c.created_at desc
      `
    : await sql`
        select c.*, su.display_name as subject_name, au.display_name as author_name
        from cardboard_checkins c
        join cardboard_users su on su.id = c.subject_user_id
        left join cardboard_users au on au.id = c.author_user_id
        where c.classroom_id = ${activeClassroom.id} and c.subject_user_id = ${subjectUserId}
        order by c.created_at desc
      `
  if (rows.length === 0) return []
  const goals = await sql`
    select * from cardboard_checkin_goals
    where checkin_id = any(${rows.map((r) => r.id)})
    order by order_index, created_at
  `
  return rows.map((row) => checkinRowToPayload(row, goals.filter((g) => g.checkin_id === row.id)))
}

function checkinRowToPayload(row, goalRows) {
  return {
    id: row.id,
    team: row.team,
    subjectUserId: row.subject_user_id,
    subjectName: row.subject_name,
    authorName: row.author_name ?? 'Unknown',
    checkinDate: String(row.checkin_date instanceof Date ? row.checkin_date.toISOString() : row.checkin_date).slice(0, 10),
    notes: row.notes,
    createdAt: row.created_at,
    goals: goalRows.map(goalRowToPayload),
  }
}

function goalRowToPayload(row) {
  return { id: row.id, text: row.goal_text, status: row.status }
}

async function createCheckin(body, user) {
  const subjectId = String(body.subjectUserId ?? '')
  if (!UUID_RE.test(subjectId)) throw new HttpError(400, 'A subject is required.')
  const team = await requireTeamSlug(String(body.team ?? ''))
  const [subject] = await sql`
    select u.id, u.display_name from cardboard_users u
    join cardboard_team_members tm on tm.user_id = u.id and tm.team_slug = ${team}
    where u.id = ${subjectId}
    limit 1
  `
  if (!subject) throw new HttpError(400, 'Subject must be a member of that team.')
  requireTeamPmOrAdmin(user, team)

  const notes = normalizeText(body.notes)
  const goalTexts = (Array.isArray(body.goals) ? body.goals : [])
    .map((g) => normalizeText(g))
    .filter(Boolean)
    .slice(0, 20)

  const [created] = await sql`
    insert into cardboard_checkins (classroom_id, team, subject_user_id, author_user_id, notes)
    values (${activeClassroom.id}, ${team}, ${subject.id}, ${user.id}, ${notes})
    returning *
  `
  const goals = []
  for (const [i, text] of goalTexts.entries()) {
    const [goal] = await sql`
      insert into cardboard_checkin_goals (checkin_id, goal_text, order_index)
      values (${created.id}, ${text}, ${i})
      returning *
    `
    goals.push(goal)
  }
  return checkinRowToPayload(
    { ...created, subject_name: subject.display_name, author_name: user.displayName },
    goals,
  )
}

async function requireCheckinAccess(checkinId, user) {
  const [row] = await sql`
    select c.*, su.display_name as subject_name, au.display_name as author_name
    from cardboard_checkins c
    join cardboard_users su on su.id = c.subject_user_id
    left join cardboard_users au on au.id = c.author_user_id
    where c.id = ${checkinId} limit 1
  `
  if (!row) return null
  requireTeamPmOrAdmin(user, row.team)
  return row
}

async function updateCheckinNotes(checkinId, body, user) {
  const row = await requireCheckinAccess(checkinId, user)
  if (!row) return null
  const notes = normalizeText(body.notes)
  const [updated] = await sql`
    update cardboard_checkins set notes = ${notes}, updated_at = now()
    where id = ${checkinId}
    returning *
  `
  const goals = await sql`
    select * from cardboard_checkin_goals where checkin_id = ${checkinId} order by order_index, created_at
  `
  return checkinRowToPayload({ ...row, ...updated }, goals)
}

async function updateCheckinGoal(goalId, body, user) {
  const [goal] = await sql`
    select g.*, c.team from cardboard_checkin_goals g
    join cardboard_checkins c on c.id = g.checkin_id
    where g.id = ${goalId} limit 1
  `
  if (!goal) return null
  requireTeamPmOrAdmin(user, goal.team)
  const status = ['pending', 'met', 'missed'].includes(body.status) ? body.status : goal.status
  const [updated] = await sql`
    update cardboard_checkin_goals set status = ${status}
    where id = ${goalId}
    returning *
  `
  return goalRowToPayload(updated)
}

function userRowToPayload(row, memberships) {
  return {
    id: row.id,
    githubLogin: row.github_login,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    memberships: memberships ?? row.memberships ?? [],
    isAdmin: isAdminLogin(row.github_login),
  }
}

function isAdminLogin(githubLogin) {
  const admins = (process.env.ADMIN_GITHUB_LOGINS ?? '')
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean)
  return admins.includes(String(githubLogin).toLowerCase())
}

async function requireCurrentUser(req) {
  const user = await getCurrentUser(req)
  if (!user) throw new HttpError(401, 'Sign in to continue.')
  return user
}

async function requireAdmin(req) {
  const user = await requireCurrentUser(req)
  if (!user.isAdmin) throw new HttpError(403, 'Admin access required.')
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
    assigneeUserId: row.assignee_user_id ?? null,
    dueDate: formatDate(row.due_date),
    tags: Array.isArray(row.tags) ? row.tags : [],
    team: row.team,
    cardStatus: row.status === 'flowing' || row.status === 'done' ? row.status : 'started',
    priority: normalizePriority(row.priority),
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

function normalizeCardNoteMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .filter(([cardId]) => /^[0-9a-f-]{36}$/i.test(cardId))
      .map(([cardId, noteText]) => [cardId, normalizeText(noteText).slice(0, 5000)]),
  )
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

// ── Teams registry ───────────────────────────────────────────────────────────
// Team slugs are validated in app code against cardboard_teams (the old
// hardcoded check constraints are gone). Cached because teams change rarely.

let teamsCache = null

async function getTeams() {
  if (!teamsCache) {
    teamsCache = await sql`
      select slug, name, archived, order_index, project_slug from cardboard_teams
      where classroom_id = ${activeClassroom.id}
      order by order_index, created_at
    `
  }
  return teamsCache
}

function teamRowToPayload(row) {
  return { slug: row.slug, name: row.name, archived: row.archived, orderIndex: row.order_index, projectSlug: row.project_slug ?? null }
}

async function isKnownTeam(slug) {
  const teams = await getTeams()
  return teams.some((t) => t.slug === slug)
}

// Loose resolve for card writes: unknown value falls back (existing team on
// update, first active team on create) rather than erroring.
async function resolveTeamSlug(value, fallback = null) {
  const teams = await getTeams()
  if (teams.some((t) => t.slug === value)) return value
  if (fallback && teams.some((t) => t.slug === fallback)) return fallback
  const firstActive = teams.find((t) => !t.archived) ?? teams[0]
  if (!firstActive) throw new HttpError(400, 'No teams exist yet.')
  return firstActive.slug
}

async function requireTeamSlug(value) {
  if (await isKnownTeam(value)) return value
  throw new HttpError(400, 'Unknown team.')
}

let projectsCache = null

async function getProjects() {
  if (!projectsCache) {
    projectsCache = await sql`
      select slug, name, archived, order_index from cardboard_projects
      where classroom_id = ${activeClassroom.id}
      order by order_index, created_at
    `
  }
  return projectsCache
}

function projectRowToPayload(row) {
  return { slug: row.slug, name: row.name, archived: row.archived, orderIndex: row.order_index }
}

const RESERVED_TEAM_SLUGS = new Set(['qna', 'notes', 'dashboard', 'admin', 'checkins', 'mine', 'new', 'teams', 'projects'])

function generateSlug(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'team'
  let slug = base
  let n = 2
  while (RESERVED_TEAM_SLUGS.has(slug) || taken.has(slug)) {
    slug = `${base}-${n}`
    n += 1
  }
  return slug
}

// A team is visible when neither it nor its project is archived. The guards
// below keep at least one visible team at all times so boards never vanish.
async function countVisibleTeams({ excludeTeamSlug, excludeProjectSlug } = {}) {
  const [teams, projects] = await Promise.all([getTeams(), getProjects()])
  const archivedProjects = new Set(projects.filter((p) => p.archived).map((p) => p.slug))
  if (excludeProjectSlug) archivedProjects.add(excludeProjectSlug)
  return teams.filter((t) =>
    !t.archived &&
    t.slug !== excludeTeamSlug &&
    !(t.project_slug && archivedProjects.has(t.project_slug)),
  ).length
}

async function createProject(body) {
  const name = normalizeText(body.name)
  if (!name) throw new HttpError(400, 'Project name is required.')
  const projects = await getProjects()
  const slug = generateSlug(name, new Set(projects.map((p) => p.slug)))
  const maxOrder = projects.reduce((max, p) => Math.max(max, p.order_index), -1)
  const [created] = await sql`
    insert into cardboard_projects (slug, classroom_id, name, order_index)
    values (${slug}, ${activeClassroom.id}, ${name}, ${maxOrder + 1})
    returning *
  `
  projectsCache = null
  return projectRowToPayload(created)
}

async function updateProject(slug, body) {
  const projects = await getProjects()
  const existing = projects.find((p) => p.slug === slug)
  if (!existing) return null
  const name = 'name' in body ? normalizeText(body.name) : existing.name
  if (!name) throw new HttpError(400, 'Project name is required.')
  const archived = 'archived' in body ? Boolean(body.archived) : existing.archived
  if (archived && !existing.archived) {
    if ((await countVisibleTeams({ excludeProjectSlug: slug })) < 1) {
      throw new HttpError(400, 'At least one team must stay visible — add another project first.')
    }
  }
  const [updated] = await sql`
    update cardboard_projects set name = ${name}, archived = ${archived}
    where slug = ${slug} and classroom_id = ${activeClassroom.id}
    returning *
  `
  projectsCache = null
  return projectRowToPayload(updated)
}

async function resolveProjectSlug(value) {
  const projects = await getProjects()
  if (value && projects.some((p) => p.slug === value)) return value
  const firstActive = projects.find((p) => !p.archived) ?? projects[0]
  if (!firstActive) throw new HttpError(400, 'No projects exist yet.')
  return firstActive.slug
}

async function createTeam(body) {
  const name = normalizeText(body.name)
  if (!name) throw new HttpError(400, 'Team name is required.')
  const teams = await getTeams()
  const projectSlug = await resolveProjectSlug(body.projectSlug)
  const slug = generateSlug(name, new Set(teams.map((t) => t.slug)))
  const maxOrder = teams.reduce((max, t) => Math.max(max, t.order_index), -1)
  const [created] = await sql`
    insert into cardboard_teams (slug, classroom_id, name, order_index, project_slug)
    values (${slug}, ${activeClassroom.id}, ${name}, ${maxOrder + 1}, ${projectSlug})
    returning *
  `
  teamsCache = null
  return teamRowToPayload(created)
}

async function updateTeam(slug, body) {
  const teams = await getTeams()
  const existing = teams.find((t) => t.slug === slug)
  if (!existing) return null
  const name = 'name' in body ? normalizeText(body.name) : existing.name
  if (!name) throw new HttpError(400, 'Team name is required.')
  const archived = 'archived' in body ? Boolean(body.archived) : existing.archived
  if (archived && !existing.archived) {
    if ((await countVisibleTeams({ excludeTeamSlug: slug })) < 1) {
      throw new HttpError(400, 'At least one team must stay active.')
    }
  }
  const projectSlug = 'projectSlug' in body
    ? await resolveProjectSlug(body.projectSlug)
    : existing.project_slug
  const [updated] = await sql`
    update cardboard_teams set name = ${name}, archived = ${archived}, project_slug = ${projectSlug}
    where slug = ${slug} and classroom_id = ${activeClassroom.id}
    returning *
  `
  teamsCache = null
  return teamRowToPayload(updated)
}

function normalizeStatus(value) {
  return value === 'flowing' || value === 'done' ? value : 'started'
}

function normalizePriority(value) {
  return value === 'high' || value === 'low' ? value : 'medium'
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
