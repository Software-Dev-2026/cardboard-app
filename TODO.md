# TODO

## Product intent (confirmed with Luke, 2026-07-07)

No formal rubric — the class is building a Jira-like tool: the teacher (admin)
creates projects and teams, assigns a PM per team, and students get real-world
accountability (report to a PM) / leadership (be a PM) experience.

Permission model decided 2026-07-07 (implemented in code, enforced server-side):
- **Edit a card** (status, assignee, priority, due date, team, title, description, labels): the card's assignee, a PM of the card's team, or an admin. Everyone else sees the card read-only (no drag, disabled fields).
- **Delete a card**: the creator, a PM of the card's team, or an admin. The delete button is hidden from everyone else.
- **Comment on a card / post Q&A**: any signed-in user (that's the reporting channel).
- **Dashboard tiles** (Overdue / Due soon / Blocked / Need help) count **open (non-Done) cards only**.
- **My Check-ins** is its own tab (`my-checkins`) visible to *everyone*, including PMs/admins — a PM can now read check-ins written about them.

## Live-testing needed for the 2026-07-07 changes (not yet run)

- [ ] As a plain student, open someone else's card: fields disabled, no drag, no delete button; direct `PATCH /api/cards/:id` returns 403
- [ ] As the assignee (non-PM), confirm you CAN edit/drag your card
- [ ] As a team PM, confirm you can edit any card on your team but NOT cards on other teams
- [ ] As a PM, confirm the "My Check-ins" tab shows check-ins written about you
- [ ] Dashboard: mark an overdue card Done, confirm it leaves the Overdue count
- [ ] Slack notification (if webhook configured) shows the team display name, not the slug

## Live-testing session state (in progress)

Working live against a scratch Neon branch `m1-test` (project `cardboard`, id `fragrant-cherry-61614697`, org `Dixie Technical College` / `org-winter-smoke-36326727`). Local `.env` is populated (gitignored, not committed) with that branch's `DATABASE_URL` and a real GitHub OAuth App (dual callback URLs: `http://localhost:5801/auth/github/callback` and `https://cardboard.twinstars.tech/auth/github/callback`). `ADMIN_GITHUB_LOGINS=LukasSampson`.

Notes for resuming:
- The `.neon` file previously pointed at a stale/inaccessible org+project — it's now fixed to point at the real `cardboard` project above.
- Port `5174` is already in permanent use locally by an unrelated project (`select-hospice`). Run this app with `PORT=5801 npm run dev` instead, or another free port — do not kill the 5174 process, it's not ours.
- To restart testing later: `npx neonctl auth` (if needed), then `PORT=5801 npm run dev`, sign in with GitHub at `http://localhost:5801`.

Checklist progress so far (Milestone 1):
- [x] Item 1 (Schema migration) — verified clean `ensureSchema()` startup and spot-checked all listed columns/tables directly via `psql` against the `m1-test` branch.
- [x] Item 2, first two sub-items — `.env` has `ADMIN_GITHUB_LOGINS`, signed in as `LukasSampson`, confirmed Admin tab appears (`/api/me` returns `isAdmin: true`).
- [ ] Item 2, remaining sub-items — promoting a PM per team and confirming a non-admin is blocked still need a second GitHub test account (deferred by user, do later).
- [x] Item 3 (Auth flow) — verified via headless browser that logged-out state shows the full sign-in wall, only `/api/me` fires (no `/api/cards`), no console errors. Anonymous posting confirmed gone: all write endpoints (and card/activity reads) return 401 without a session cookie.
- Role-scoping facts confirmed in code (server.mjs + App.tsx): PM Notes requires strictly `role === 'pm'` — admin does NOT bypass, so a self-promoted admin validly tests PM Notes scoping. But the Dashboard team-switcher and team-activity API key off `isAdmin`, so an admin who self-promotes to PM still sees the switcher — Item 8's "PM sees only own team, no switcher" needs a true non-admin PM account.
- [ ] Item 4 (Card accountability) — next up, not started. Needs to be walked through in the user's real logged-in browser session (create card → check activity log → change status → reassign → comment → My Tasks toggle).
- [ ] Items 5–8 — not started.

## Before merging Milestone 1 to `main`

### 1. Schema migration
- [x] Run `npm run dev` and confirm `ensureSchema()` completes with no errors on startup
- [x] Spot-check in the Neon SQL editor: `cardboard_users` has `role`/`team` columns, `cardboard_card_notes`/`cardboard_scratch_notes` have a `team` column (not `manager_id`), `cardboard_cards` has `assignee_user_id`, and `cardboard_card_events`/`cardboard_card_comments` exist

### 2. Admin setup
- [x] Add `ADMIN_GITHUB_LOGINS=your-login,instructor-login` to `.env`
- [x] Sign in with your GitHub account, confirm the **Admin** tab appears
- [ ] Promote one student per team to PM (role `pm` + `team1`/`team2`) from the Admin tab — MECHANISM VERIFIED: promoted/reverted the seeded Test Student via the admin API and role/team scoping behaved correctly (2026-07-06); the real per-team promotions happen when classmates sign in
- [x] Confirm a non-admin account cannot see the Admin tab or hit `PATCH /api/admin/users/:id` directly — verified with a session for the seeded Test Student: no Admin tab or Manage section in sidebar (screenshot), and `PATCH /api/admin/users/:id` returns 403 (2026-07-06)

### 3. Auth flow
- [x] Confirm the app shows a full sign-in wall when logged out (no board content, no `/api/cards` request in the network tab)
- [x] Confirm anonymous posting is gone everywhere — verified via curl with no session cookie: `POST /api/questions`, `POST /api/cards`, `POST /api/cards/:id/comments`, `POST /api/questions/:id/answers`, `PATCH /api/admin/users/:id`, and even `GET /api/cards` / `GET /api/teams/:team/activity` all return 401 (2026-07-05)

### 4. Card accountability
- [x] Create a card, confirm an activity entry says "created" — verified in DB: card "The Studio App" has a `created` event with actor Luke Sampson (2026-07-05)
- [x] Change its status, confirm an activity entry logs the old → new status — DB shows `status_changed` event `started → flowing` with actor Luke Sampson (2026-07-05)
- [x] Reassign it via the edit form's new Assignee picker, confirm it persists after reload — reassigned to seeded "Test Student" dummy user, persisted in DB and across reload; `assignee_changed` event (Luke Sampson → Test Student) also logged (2026-07-05)
- [x] Post a comment as one user, reload as a different user, confirm it's visible with the right author — comment posted as Luke, then fetched with a Test Student session: correct author "Luke Sampson" returned (2026-07-06)
- [x] Toggle **My Tasks** and confirm it filters to cards assigned to you, across both team tabs — user-verified in UI (2026-07-05)

### 5. PM Notes
- [ ] As a team's PM, confirm you only see that team's notes with no toggle to the other team
- [ ] As a plain student, confirm the PM Notes tab is not visible at all — API half verified: Test Student session gets 403 on `GET /api/pm-notes`, and their sidebar screenshot shows no PM Notes tab (2026-07-06); one glance from a real classmate account later will fully close this

### 6. Regression check
- [x] Confirm posting a Q&A question/answer while logged in shows your real name (no more "Anonymous") — user-verified in UI; DB rows show author "Luke Sampson" on both question and answer (2026-07-06)

---

## Before merging Milestone 2 to `main`

Milestone 2 (priority + PM Dashboard) is implemented and passes `lint`/`build`/`tsc`. Same caveat as Milestone 1 — needs your real GitHub OAuth + Neon `DATABASE_URL` to test live. I validated the schema upgrade path (adding `priority` to `cardboard_cards` and widening the `cardboard_card_events` check constraint to accept `priority_changed`) against a local Postgres seeded with simulated Milestone-1-shaped data — it applied cleanly, backfilled existing cards to `priority = 'medium'`, and didn't touch the pre-existing `created` event. Still needs a real run against your Neon branch.

### 7. Priority
- [x] Create a card, confirm it defaults to **Medium** priority — DB shows `priority = 'medium'` on the new card (2026-07-05); badge color check still open below
- [x] Change priority on an existing card (both up and down), confirm an activity entry logs the old → new priority — DB shows `priority_changed` events medium→low and low→high, both with correct actor (2026-07-06)
- [x] Confirm the priority badge on each card shows the right color (High = red, Medium = amber, Low = gray) — user-verified High=red in redesigned UI; Medium=amber verified via screenshot (2026-07-06)

### 8. PM Dashboard
- [x] As a team's PM, open the **Dashboard** tab — confirm it shows only your own team, with no team-switcher — verified with Test Student promoted to PM+team2: title "Team 2 Dashboard", zero switchers rendered, own-team activity 200, other-team 403; reverted to student after (2026-07-06). NOTE: since multi-team memberships landed, a PM of 2+ teams *correctly* gets a switcher limited to their own teams — the "no switcher" expectation only applies to single-team PMs.
- [ ] As an admin, open Dashboard — confirm you can toggle between Team 1 and Team 2
- [x] As a plain student (non-PM, non-admin), confirm the Dashboard tab is not visible, and `GET /api/teams/team1/activity` returns 403 if called directly — sidebar screenshot shows no Dashboard tab; both teams' activity endpoints return 403 for a student session (2026-07-06)
- [ ] Confirm the four numbers (Overdue, Due soon, Blocked, Need help) match what you'd count by hand on the board — counting **open cards only**; Done cards are excluded as of 2026-07-07 (they previously counted, which would have failed this check)
- [ ] Confirm the Workload list reflects open (non-Done) cards per assignee
- [ ] Confirm the Recent Activity feed shows events across multiple cards on that team, most recent first, and includes the card title for context

---

## Explicitly deferred (not started)

Nothing further was requested beyond Milestones 1 and 2. If the class wants more later, natural next steps this schema doesn't block: sprint/cycle grouping, due-date reminders, per-card ordering within a column (the `order_index` column already exists but isn't user-reorderable yet).

## Nice-to-haves not requested, noted for later if useful

- Card deletion leaves no trace (events/comments cascade away) — if accountability ever matters more, log deletions to a surviving table or soft-delete
- If an admin edits their own memberships in the Admin tab, the sidebar role chip / PM tabs don't refresh until reload
- Due-date chips and dashboard counts compute against the page-load date (`TODAY`), so a tab left open overnight goes stale until refreshed
- Card updates are last-write-wins on the whole card — two people editing the same card at once silently clobber each other (fine at class scale)
- Edit/delete on your own comments (currently comments are post-only, no edit/delete)
- Comment threading UI (the `parent_comment_id` column exists in the schema but is unused — comments render as a flat list for now)
- A "no team" state for students is currently allowed indefinitely; you may want to nudge students to self-select a team at some point if the roster grows
- Dashboard's per-person workload counts by display name, not by user id — if two people ever share a display name it'll merge their counts (unlikely at class scale, but worth knowing)
