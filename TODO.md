# TODO

## Before merging Milestone 1 to `main`

The code is complete and passes `lint`/`build`/`tsc`, but the following require your real GitHub OAuth credentials and Neon `DATABASE_URL` — neither is available in the environment this was built in, so none of this has been run live yet.

**Recommended: do this against a scratch Neon branch first, not your production classroom database.**

```bash
npx neonctl branches create --name m1-test
npx neonctl env pull --branch m1-test
```

### 1. Schema migration
- [ ] Run `npm run dev` and confirm `ensureSchema()` completes with no errors on startup
- [ ] Spot-check in the Neon SQL editor: `cardboard_users` has `role`/`team` columns, `cardboard_card_notes`/`cardboard_scratch_notes` have a `team` column (not `manager_id`), `cardboard_cards` has `assignee_user_id`, and `cardboard_card_events`/`cardboard_card_comments` exist
  - *(I already verified the DDL itself against a real local Postgres, including a simulated copy of your existing manager1/manager2 data — the rename preserved everything correctly. This step is just confirming it behaves the same against your actual Neon database.)*

### 2. Admin setup
- [ ] Add `ADMIN_GITHUB_LOGINS=your-login,instructor-login` to `.env`
- [ ] Sign in with your GitHub account, confirm the **Admin** tab appears
- [ ] Promote one student per team to PM (role `pm` + `team1`/`team2`) from the Admin tab
- [ ] Confirm a non-admin account cannot see the Admin tab or hit `PATCH /api/admin/users/:id` directly

### 3. Auth flow
- [ ] Confirm the app shows a full sign-in wall when logged out (no board content, no `/api/cards` request in the network tab)
- [ ] Confirm anonymous posting is gone everywhere (Q&A, cards, comments all require login)

### 4. Card accountability
- [ ] Create a card, confirm an activity entry says "created"
- [ ] Change its status, confirm an activity entry logs the old → new status
- [ ] Reassign it via the edit form's new Assignee picker, confirm it persists after reload
- [ ] Post a comment as one user, reload as a different user, confirm it's visible with the right author
- [ ] Toggle **My Tasks** and confirm it filters to cards assigned to you, across both team tabs

### 5. PM Notes
- [ ] As a team's PM, confirm you only see that team's notes with no toggle to the other team
- [ ] As a plain student, confirm the PM Notes tab is not visible at all

### 6. Regression check
- [ ] Confirm posting a Q&A question/answer while logged in shows your real name (no more "Anonymous")

---

## Before merging Milestone 2 to `main`

Milestone 2 (priority + PM Dashboard) is implemented and passes `lint`/`build`/`tsc`. Same caveat as Milestone 1 — needs your real GitHub OAuth + Neon `DATABASE_URL` to test live. I validated the schema upgrade path (adding `priority` to `cardboard_cards` and widening the `cardboard_card_events` check constraint to accept `priority_changed`) against a local Postgres seeded with simulated Milestone-1-shaped data — it applied cleanly, backfilled existing cards to `priority = 'medium'`, and didn't touch the pre-existing `created` event. Still needs a real run against your Neon branch.

### 7. Priority
- [ ] Create a card, confirm it defaults to **Medium** priority
- [ ] Change priority on an existing card (both up and down), confirm an activity entry logs the old → new priority
- [ ] Confirm the priority badge on each card shows the right color (High = red, Medium = amber, Low = gray)

### 8. PM Dashboard
- [ ] As a team's PM, open the **Dashboard** tab — confirm it shows only your own team, with no team-switcher
- [ ] As an admin, open Dashboard — confirm you can toggle between Team 1 and Team 2
- [ ] As a plain student (non-PM, non-admin), confirm the Dashboard tab is not visible, and `GET /api/teams/team1/activity` returns 403 if called directly
- [ ] Confirm the four numbers (Overdue, Due soon, Blocked, Need help) match what you'd count by hand on the board
- [ ] Confirm the Workload list reflects open (non-Done) cards per assignee
- [ ] Confirm the Recent Activity feed shows events across multiple cards on that team, most recent first, and includes the card title for context

---

## Explicitly deferred (not started)

Nothing further was requested beyond Milestones 1 and 2. If the class wants more later, natural next steps this schema doesn't block: sprint/cycle grouping, due-date reminders, per-card ordering within a column (the `order_index` column already exists but isn't user-reorderable yet).

## Nice-to-haves not requested, noted for later if useful

- Edit/delete on your own comments (currently comments are post-only, no edit/delete)
- Comment threading UI (the `parent_comment_id` column exists in the schema but is unused — comments render as a flat list for now)
- A "no team" state for students is currently allowed indefinitely; you may want to nudge students to self-select a team at some point if the roster grows
- Dashboard's per-person workload counts by display name, not by user id — if two people ever share a display name it'll merge their counts (unlikely at class scale, but worth knowing)
