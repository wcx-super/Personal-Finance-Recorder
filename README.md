# Personal-Finance-Recorder

A small multi-user expense tracker: sign up, record income and expenses, filter them,
and see where the money went. The back end is a JSON API on Express 5 and PostgreSQL;
the front end is a few static pages in plain JavaScript that call it — no client-side
framework, no build step.

Live: <https://personal-finance-recorder.onrender.com>

## Features

- Accounts with email and password; every user sees and edits only their own ledger
- Add income/expense entries with amount, category, date and an optional note
- Filter the ledger by type and category; filters live in the URL, so they survive
  refresh, back/forward and bookmarking
- Running balance, income/expense totals, and a per-category expense breakdown
- Category suggestions that grow from what you have actually used
- Delete a single entry or clear your ledger

<img width="1404" height="1275" alt="屏幕截图 2026-09-23 090658" src="https://github.com/user-attachments/assets/a81f0843-d68a-4e93-b8ec-113e25504c94" />
<img width="1441" height="654" alt="屏幕截图 2026-09-23 090708" src="https://github.com/user-attachments/assets/fee0c356-7540-49db-803a-f6a8e9dbbce0" />

## Requirements

- Node.js 24 (pinned in `package.json` `engines`; uses the built-in `--env-file-if-exists` flag, so there is no `dotenv` dependency)
- PostgreSQL 9.6 or newer (uses aggregate `FILTER`, `ON CONFLICT` and `ADD COLUMN IF NOT EXISTS`)
- Or just Docker, which brings both

## Running locally

```bash
git clone https://github.com/wcx-super/Personal-Finance-Recorder
cd Personal-Finance-Recorder
npm install
cp .env.example .env
```

Fill in `.env`. `SESSION_SECRET` can be any long random string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create the database named in `PGDATABASE`, then:

```bash
npm run dev     # restarts on file changes
npm start       # plain
```

Open <http://localhost:8000> and sign up. Tables and indexes are created on startup,
so there is no separate migration step.

## Running with Docker

```bash
docker compose up --build
```

This starts the app and a PostgreSQL 17 container side by side; no local Node or
PostgreSQL is needed. Data lives in the `db-data` volume, so it survives restarts.
`docker compose down -v` removes it.

`compose.yaml` sets `NODE_ENV=development` on purpose: the image defaults to
`production`, which marks the session cookie `Secure`, and a `Secure` cookie is never
sent over plain `http://localhost` — sign-in would succeed and then every request
would come back 401.

## API

Every endpoint takes and returns JSON. Authentication is a session cookie set by
`/api/register` or `/api/login`; endpoints marked "yes" return `401` without it.

| Method   | Path                   | Login | Success | Purpose                                          |
| -------- | ---------------------- | ----- | ------- | ------------------------------------------------ |
| `POST`   | `/api/register`        |       | `201`   | Create an account and log in (rate limited)      |
| `POST`   | `/api/login`           |       | `200`   | Log in (rate limited)                            |
| `POST`   | `/api/logout`          |       | `204`   | Destroy the session                              |
| `GET`    | `/api/me`              | yes   | `200`   | The logged-in user                               |
| `GET`    | `/api/records`         | yes   | `200`   | Your records, newest first; `?type=` `?category=` |
| `GET`    | `/api/stats`           | yes   | `200`   | Balance, totals, per-category expenses           |
| `POST`   | `/api/records`         | yes   | `201`   | Create a record; returns it                      |
| `DELETE` | `/api/records/:id`     | yes   | `204`   | Delete one of your records                       |
| `DELETE` | `/api/records`         | yes   | `204`   | Clear your ledger                                |

Errors always have the same shape, with the status code carrying the meaning:
`400` bad input, `401` not logged in or wrong password, `404` no such record (or not
yours), `409` email already registered, `413` body over 10 KB, `429` too many attempts.

```http
POST /api/records
Content-Type: application/json

{ "type": "expense", "amount": "12.50", "category": "Dining", "note": "lunch", "date": "2026-10-01" }
```

```http
HTTP/1.1 201 Created

{ "id": 42, "type": "expense", "amount": 12.5, "category": "Dining", "note": "lunch", "date": "2026-10-01", "user_id": 7 }
```

```http
HTTP/1.1 400 Bad Request

{ "error": "date must be a real date in YYYY-MM-DD format" }
```

## Tests

The tests drive the real API over HTTP with `supertest` against a separate database.
Create a database whose name ends in `_test` (for example `ledger_test`), then a
`.env.test` alongside `.env`:

```ini
PGUSER=postgres
PGHOST=localhost
PGDATABASE=ledger_test
PGPASSWORD=your-password-here
PGPORT=5432
SESSION_SECRET=any-test-secret
```

```bash
npm test
```

The suite wipes its database before running, so it refuses to start unless the
database name ends in `_test`. Its 8 tests cover what is easiest to get wrong in a
multi-user app: requests without a session get 401, one user's records, categories
and totals never appear in another user's responses, nobody can delete or clear
someone else's records, wrong passwords are rejected, impossible dates are a 400 and
not a 500, and logging out really ends the session.

GitHub Actions runs the same suite on every push to `main` and on every pull request,
against a throwaway PostgreSQL service container (`.github/workflows/test.yml`).

## Configuration

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | Full connection string; takes precedence over the `PG*` variables. SSL is controlled by the string itself, e.g. `?sslmode=verify-full` |
| `PGUSER` `PGHOST` `PGDATABASE` `PGPASSWORD` `PGPORT` | Used when `DATABASE_URL` is not set |
| `SESSION_SECRET` | Signs the session cookie. Required — the app refuses to start without it |
| `NODE_ENV` | `production` marks the session cookie `Secure` |
| `PORT` | Port to listen on (default `8000`) |

## Deployment

Deployed on Render as a Docker web service, with the database on Neon:

- Render builds the `Dockerfile` and runs `node server.js` as the unprivileged `node`
  user; `.dockerignore` keeps `.env` files and tests out of the image
- `DATABASE_URL`, `SESSION_SECRET` and `NODE_ENV=production` are set in the Render
  dashboard, never in the repository
- Pushes to `main` are tested by GitHub Actions and deployed by Render

## Project structure

```
server.js            Startup: create tables, listen, shut down gracefully
app.js               The Express app: API routes, queries, validation, sessions, errors
static/              Served as-is by express.static
  index.html         The ledger page (markup only)
  login.html         Login form
  register.html      Sign-up form
  api.js             fetch wrapper: JSON in and out, errors become ApiError
  app.js             Ledger page: loads data, renders it, handles add/delete/filter
  auth.js            Login and sign-up form handling
  style.css
test/
  isolation.test.js  Per-user isolation and validation tests
Dockerfile           Production image
compose.yaml         Local app + PostgreSQL
.github/workflows/   CI
```

## Design notes

### A JSON API with a static front end

An earlier version rendered every page on the server with EJS. It now serves only
JSON, and the pages are static HTML that fetch their data. The back end got smaller
— no templates, no redirects, no formatting — and every operation is reachable with
a single HTTP call, which is what makes the API testable on its own and usable by
something other than this page. Adding a record or deleting one now updates the page
in place instead of reloading it.

The cost is that the browser does the rendering, so the escaping EJS used to do for
free is now the front end's job. Everything a user typed is put on the page with
`textContent`, `new Option()` or `createElement`; nothing goes through `innerHTML`.
The page also needs JavaScript to show anything at all.

### Every query is scoped to the current user

`requireLogin` runs before every ledger endpoint. It loads the user named in the
session and puts it on `req.user`; past that point, every query carries
`user_id = req.user.id`. The id always comes from the session, never from the
request body.

Deletes are the place this matters most. `DELETE ... WHERE id = $1 AND user_id = $2
RETURNING id` means a guessed record id from someone else's ledger simply matches
nothing and becomes a 404. The tests check the totals and category lists too, not
only the record list, because a missing filter in one of the three `getStats` queries
would leak other users' numbers while the record list still looked fine.

### Sessions and passwords

Passwords are hashed with bcrypt (cost 12) and never stored or logged in plain text.
Unknown emails and wrong passwords get the same message, so the login endpoint cannot
be used to discover who has an account. Passwords over 72 bytes are rejected because
bcrypt silently ignores everything past that point.

Sessions live in PostgreSQL through `connect-pg-simple` rather than in memory, so a
restart or a free-tier sleep does not log everyone out, and logging out deletes the
server-side row so a copied cookie stops working. The session id is regenerated at
login to prevent session fixation. The cookie is `HttpOnly`, so page scripts cannot
read it.

A session cookie on an API invites cross-site request forgery, and two things close
that door. The cookie is `SameSite=Lax`, so the browser leaves it off cross-site
`POST` and `DELETE` requests. And the API only parses `application/json` bodies,
which another site's HTML form cannot send; a script on another origin could, but
only after a CORS preflight that this API never approves.

### Defense in depth in the browser

`helmet` sets a Content Security Policy that only runs scripts from the site's own
files and refuses inline event handlers, so even markup that slipped past
`textContent` could not execute. That is why every page loads its behavior from a
`.js` file and attaches listeners with `addEventListener`.

Login and sign-up are rate limited per IP. Only failed logins count, so signing in
and out repeatedly never locks you out. Counters are in memory and reset on restart.

### One validation boundary

Request bodies come from whoever sent them — a crafted `curl` call bypasses
`required`, `min` and `maxlength` without effort. `parseRecord`, `parseId` and
`parseCredentials` run as the first statement of each handler and return typed,
trimmed values. Past that line, the rest of the handler can treat its input as
well-formed.

The checks are not decorative. PostgreSQL's `NUMERIC` accepts `NaN` as a legitimate
value, so an unvalidated `Number("abc")` inserts cleanly and then poisons every
`SUM` that touches it. `TEXT` columns accept any `type` string, so a bogus value
would be invisible to both `FILTER (WHERE type = 'income')` and its expense
counterpart — the money would silently vanish from the totals while still showing
in the list. Amounts above what `NUMERIC(12, 2)` can hold, and well-formed but
impossible dates like `2026-02-30`, are rejected before they reach the database.
Request bodies are capped at 10 KB.

### Typed errors, one handler

Validation failures `throw new HttpError(status, detail)`. A single Express error
middleware turns them into `{ "error": detail }` with that status; client errors
raised by Express itself, such as malformed JSON or an oversized body, keep their
status too. Anything else is logged and becomes a 500. Express 5 forwards rejections
from async handlers automatically, so no route needs its own `try`/`catch`.

The front end mirrors this: `static/api.js` turns any non-2xx response into an
`ApiError` carrying the status, so a page can send a `401` to the login screen and
show anything else next to the form.

The point of the distinction is honesty: a 400 tells the user to fix their input, a
500 admits the server is broken. Letting a bad amount surface as a 500 would blame
the wrong party.

### Parameterized queries, including the dynamic ones

Values always travel as `$1`-style parameters, never string interpolation. The
filtered list needs a `WHERE` clause whose shape is not known until runtime, so
conditions and parameters are accumulated in two parallel arrays, starting from the
user filter:

```js
const where = ["user_id = $1"];
const params = [userId];
if (category) {
  params.push(category);
  where.push(`category = $${params.length}`);
}
```

Pushing the value first means `params.length` is already the 1-based index that
PostgreSQL's placeholder numbering expects. The SQL *structure* is assembled in
JavaScript; the *values* are never part of that string.

### Dates and numbers at the driver boundary

Two PostgreSQL types need custom parsers. `DATE` would otherwise become a JS `Date`
interpreted in the server's timezone, which can shift the day; it is kept as a
`YYYY-MM-DD` string. `NUMERIC` arrives as a string to protect precision, which turns
arithmetic into string concatenation if ignored, so it is parsed to a number.
`COUNT(*)` returns `bigint` and stays a string — converted explicitly where it is
used.

The form's default date is "today" for the person filling it in, not for the server,
which runs in UTC — so the browser fills it in from the user's own clock.

### Schema changes on startup

`initDb` runs on every start and is written to be idempotent: `CREATE TABLE IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS`, `SET NOT NULL`. `user_id` was added to an
existing table that already had rows, so it went in nullable, the old rows were
assigned to their owner by hand, and only then was `NOT NULL` added. That last
statement also acts as a guard: if ownerless rows ever appear, the app refuses to
start rather than run with them. A schema that changes more often than this would
want a real migration tool.

### Connection pool

`getStats` issues three aggregate queries through `Promise.all`. A single `Client`
serializes them on one connection — pg 8 queues them with a deprecation warning, and
pg 9 will refuse. A `Pool` hands each query its own connection and runs them
concurrently. The pool has an `error` listener, because hosted databases drop idle
connections and an unhandled `error` event would crash the process.

One consequence worth naming: those three queries see three independent snapshots,
so a concurrent write could make the totals and the category breakdown disagree by
one entry. A transaction would fix it at the cost of giving up the concurrency. For
a personal ledger it is not worth it.

### Graceful shutdown

On `SIGTERM` (sent by Render and Docker on every redeploy) and `SIGINT`, the server
stops accepting connections, lets in-flight requests finish, then closes the session
store and the pool. The container runs `node server.js` directly rather than through
`npm start`, so the signal reaches Node instead of stopping at npm.

## Known limitations

- The pages need JavaScript; with it disabled they stay empty
- Authentication is cookie-based, which suits this same-origin front end; a mobile
  app or third-party client would want token-based auth instead
- No endpoint to edit a record; fixing a mistake means deleting and re-adding it
- Rate limiting is per IP and in memory: many IPs guessing one account are not
  slowed down, and a restart resets the counters
- Categories are derived from existing rows, so deleting the last entry in a
  category removes it from the dropdowns
- Category matching is case-sensitive: `Dining` and `dining` are two categories
- No password reset or email verification
- No pagination; `/api/records` returns every row
