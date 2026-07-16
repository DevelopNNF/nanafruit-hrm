# HRM

npm workspaces monorepo. Two frontends, one API.

| Workspace | Port | What it is |
| --- | --- | --- |
| `admin/` | 5173 | Web app for Admin/HR. Desktop. Password login. |
| `liff/` | 5174 | LINE LIFF app for employees and supervisors. Mobile only, runs inside the LINE app. |
| `server/` | 3000 | Express + PostgreSQL API. Serves **both** frontends. |
| `shared/` | — | The API contract: types, plus the enum values both sides validate against. |

## Why admin and liff are separate

They are separate builds, not routes in one app, because:

- `liff.init()` must run before render in `liff/` and must never run in `admin/`.
- The LIFF SDK is ~34 kB gzipped. Admin should not ship it to a phone, and the phone should not ship HR's tables and reports.
- Auth differs: admin uses a session, liff verifies a LINE ID token.
- A LIFF app points at exactly one endpoint URL in the LINE console.

`liff/` is a **frontend**. It is not a second backend — both frontends talk to `server/`. LINE Messaging API webhooks, when they arrive, belong in `server/`, not here.

## Setup

```bash
npm install                        # once, at the root — workspaces share one lockfile
cp server/.env.example server/.env # fill in PGPASSWORD
cp liff/.env.example liff/.env     # fill in VITE_LIFF_ID
npm run migrate -w server          # create the tables (needs the PGDATABASE to exist)
```

## Run

```bash
npm run dev:server
npm run dev:admin
npm run dev:liff
```

Both frontends proxy `/api` to port 3000 in dev, so the browser stays on one origin and CORS never applies. In production, set `CORS_ORIGIN` on the server to a comma-separated list of both real origins.

`npm run build`, `npm run lint`, `npm run typecheck` run across every workspace.

## Database

Schema changes are plain SQL files in `server/migrations/`, named `NNN_description.sql` and applied in filename order:

```bash
npm run migrate -w server
```

The runner (`server/src/migrate.ts`) records each applied file in a `schema_migrations` table and skips it next time, so it is safe to re-run and only ever applies what is pending. Each file runs inside its own transaction — a migration that fails partway leaves nothing behind.

There is no `down`. To change something, add a new numbered file; never edit one that has already been applied.

## Working on liff/

LIFF needs an HTTPS URL that LINE's servers can reach, so `localhost:5174` alone will not load in the LINE app. Put a tunnel in front of it:

```bash
cloudflared tunnel --url http://localhost:5174   # or: ngrok http 5174
```

Then set the tunnel's HTTPS URL as the LIFF app's Endpoint URL in the LINE Developers Console. `allowedHosts: true` in `liff/vite.config.ts` is what lets Vite accept the tunnel's hostname.

Opening `liff/` in a normal browser shows a boot error rather than the app — that is expected, since there is no LINE context to init against.

## shared/

`shared/` holds the API contract: the request/response types, and the allowed values for the enum-ish fields (`EMPLOYEE_STATUSES`, `EMPLOYMENT_TYPES`, `TITLES`). Those arrays are exported as runtime values, not just types, so that the admin dropdowns and the server's validation are driven by one list instead of two that can drift apart.

That means `shared/` **emits JavaScript and must be built** before `server/` starts or the frontends typecheck:

```bash
npm run build -w shared   # once
npm run dev -w shared     # or leave this running while editing shared/
```

`npm install` covers the fresh-clone case via `shared`'s `prepare` script, and `npm run build` at the root builds workspaces in dependency order. But `server`'s `tsx watch` follows `@hrm/shared` to `dist/`, not `src/` — so an edit to `shared/` that you don't rebuild will not be picked up.

It was previously types-only and consumed straight from source; that constraint was dropped when the Employee contract needed shared enum values.
