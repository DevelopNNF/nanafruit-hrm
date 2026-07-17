# HRM

npm workspaces monorepo. Two frontends, one API.

| Workspace | Port | What it is |
| --- | --- | --- |
| `admin/` | 5173 | Web app for Admin/HR. Desktop. Sign-in with Microsoft Entra ID. |
| `liff/` | 5174 | LINE LIFF app for employees and supervisors. Mobile only, runs inside the LINE app. |
| `server/` | 3000 | Express + PostgreSQL API. Serves **both** frontends. |
| `shared/` | — | The API contract: types, plus the enum values both sides validate against. |

## Why admin and liff are separate

They are separate builds, not routes in one app, because:

- `liff.init()` must run before render in `liff/` and must never run in `admin/`.
- The LIFF SDK is ~34 kB gzipped. Admin should not ship it to a phone, and the phone should not ship HR's tables and reports.
- Auth differs: admin signs in against Entra ID, liff against LINE.
- A LIFF app points at exactly one endpoint URL in the LINE console.

`liff/` is a **frontend**. It is not a second backend — both frontends talk to `server/`. LINE Messaging API webhooks, when they arrive, belong in `server/`, not here.

## Setup

```bash
npm install                        # once, at the root — workspaces share one lockfile
cp server/.env.example server/.env # fill in PGPASSWORD, ENTRA_*, LINE_CHANNEL_ID, SESSION_JWT_SECRET
cp admin/.env.example admin/.env   # fill in the VITE_ENTRA_* values
cp liff/.env.example liff/.env     # fill in VITE_LIFF_ID
npm run migrate -w server          # create the tables (needs the PGDATABASE to exist)
```

## Auth

`admin/` signs in against **Microsoft Entra ID** and sends the access token as
`Authorization: Bearer`. The server verifies it against Microsoft's published
keys — no session store, no cookie, so nothing to keep in sync between the two.
Permissions come from **App roles** on the app registration (`HRM.Admin`,
`HRM.HR`, `HRM.Viewer`), which arrive in the token's `roles` claim: IT grants
them in Entra alongside everyone's other Microsoft365 access, and this codebase
never stores who is an admin.

`/api/health` is open, because that is what a load balancer polls and it reveals
nothing. Everything else needs a token. `/api/me` needs a token but no role — a
signed-in user with no role assigned still gets an answer, which is what lets
admin/ say "contact IT" instead of showing an empty table.

`liff/` signs in against **LINE**. On boot it trades `liff.getIDToken()` for a
session of our own at `POST /api/auth/line/session` — the LINE token is verified
against LINE once, there, and never sent again. It is exchanged rather than
forwarded because the LIFF SDK does not renew it, and because our token can carry
the employee id, which LINE knows nothing about.

An employee claims their record once, with a code HR issues from the employee's
page in `admin/`. The code is single-use, expires in 24 hours, and only its hash
is stored — HR sees the plaintext once, at creation, and reissues if it is lost.
Until a LINE account is claimed, `/api/auth/line/session` answers `NOT_LINKED`
and `liff/` shows the link screen instead of the app.

Both frontends send a Bearer token; the server picks a verifier by the token's
`iss`, which is a URL for Entra and the string `hrm` for our own sessions.

### The audit log

Every change to an employee writes a row to `audit_log` naming who did it — the
Entra oid and upn for an admin, the employee id for someone acting through
`liff/`. The insert runs in the same transaction as the change, so a committed
change without its audit row is not a state the database can reach, and a
rejected one leaves nothing behind.

It records the action, not a before/after diff: that is a bigger feature and a
much bigger pile of personal data to hold. Link codes never appear in `detail` —
the log would then hold a live credential in plaintext, which is the thing
hashing them was for. Nothing in the app reads the table yet; it is queried by
hand.

### Rate limits

`/api/auth/line/session` and `/api/auth/line/link` are the only routes that
answer before the caller has a token, so they are the only ones with limits, and
each has its own bucket. They are not what stops a link code being guessed — 39
bits of randomness is — they are there so a script cannot make us call LINE all
day.

The keys are IP addresses, which are blunt: an office shares one and a mobile
carrier shares a few thousand. The limits are set to be generous rather than
tight for that reason. **`TRUST_PROXY` must match the real number of proxies in
front of the server**, or the limiter keys on the wrong address: too low and
everyone behind the load balancer shares one bucket, too high and the header can
be forged for a fresh bucket per request.

### Configuration

One app registration backs both `admin/` and the API, so `ENTRA_TENANT_ID` and
`ENTRA_API_CLIENT_ID` in `server/.env` are the same two values as
`VITE_ENTRA_TENANT_ID` and `VITE_ENTRA_CLIENT_ID` in `admin/.env`. None of them
are secret. The registration must set `accessTokenAcceptedVersion: 2` in its
manifest, or it issues v1 tokens whose `iss` is `sts.windows.net` and every
request fails the issuer check.

`SESSION_JWT_SECRET` is the one real secret here: it signs the sessions issued to
`liff/`, so whoever holds it can mint one for any employee. Every environment
needs its own.

In production `CORS_ORIGIN` must name **both** real origins. In dev it barely
matters — each frontend proxies `/api` to port 3000, so the browser never makes a
cross-origin request — which is exactly why a missing origin shows up only after
a deploy.

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

Opening `liff/` in a normal browser does not show the app: `liff.init()` succeeds, finds no session, and redirects to LINE's login page. Signing in there sends you back to the LIFF app's registered **Endpoint URL** — not to your localhost — so the way to see the app on a dev machine is the tunnel above, not a browser tab.

The LIFF app needs the **openid** scope, or `liff.getIDToken()` returns null and
the app cannot prove who its user is. `LINE_CHANNEL_ID` in `server/.env` is the
Login channel behind the LIFF app — the numeric half of the LIFF ID.

## shared/

`shared/` holds the API contract: the request/response types, and the allowed values for the enum-ish fields (`EMPLOYEE_STATUSES`, `EMPLOYMENT_TYPES`, `TITLES`). Those arrays are exported as runtime values, not just types, so that the admin dropdowns and the server's validation are driven by one list instead of two that can drift apart.

That means `shared/` **emits JavaScript and must be built** before `server/` starts or the frontends typecheck:

```bash
npm run build -w shared   # once
npm run dev -w shared     # or leave this running while editing shared/
```

`npm install` covers the fresh-clone case via `shared`'s `prepare` script, and `npm run build` at the root builds workspaces in dependency order. But `server`'s `tsx watch` follows `@hrm/shared` to `dist/`, not `src/` — so an edit to `shared/` that you don't rebuild will not be picked up.

It was previously types-only and consumed straight from source; that constraint was dropped when the Employee contract needed shared enum values.
