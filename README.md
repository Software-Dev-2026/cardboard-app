# Project manager tool

A classroom project board built with Vite, React, TypeScript, Yarn, and Neon Postgres.

## Features

- Student-friendly card sections for started, flowing, and done work
- Team tabs, Q&A, and PM notes views
- Real assignees, per-card activity history, and threaded comments tied to a signed-in identity
- Team-scoped PM role (each team's acting PM only sees their own team's notes)
- Neon-backed card persistence through a small Node API
- Classroom-aware database tables for school years, classrooms, students, cards, questions, and answers
- One active classroom by default, with year-to-year reset handled by creating a new classroom/school-year record

## Stack

- Vite
- React 19
- TypeScript
- Yarn 4
- Node HTTP server
- Neon Postgres

## Getting started

```bash
npx -y @yarnpkg/cli-dist@4.14.1 install
npx -y neonctl env pull
npm run dev
```

The server reads `DATABASE_URL` from `.env`, creates the `cardboard_*` tables if needed, and serves both the API and the Vite app.

## GitHub login

GitHub sign-in is required to use the app — there is no anonymous mode. Create a GitHub OAuth App and add these values to `.env`:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

For local development, set the GitHub OAuth callback URL to the URL printed by `npm run dev` plus `/auth/github/callback`.
For example: `http://localhost:5174/auth/github/callback`.

## Roles and admins

Every user starts as a `student`. Two admins (identified by GitHub login, not stored in the database) can promote a user to `pm` for a specific team from the in-app Admin tab:

```bash
ADMIN_GITHUB_LOGINS=your-github-login,instructor-github-login
```

A PM only ever sees and edits their own team's PM notes — this is enforced server-side, not just hidden in the UI.

## Slack notifications

Create a Slack incoming webhook and add the URL to `.env`:

```bash
SLACK_WEBHOOK_URL=...
```

The server sends Slack notifications when someone creates a new card or posts a new Q&A question.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

## Classroom rollover

At the end of a school year, archive the existing classroom row and create a new `cardboard_school_years` + `cardboard_classrooms` pair. Cards are scoped by `classroom_id`, so old classes can be retained without mixing with the new roster.
