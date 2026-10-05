# Personal-Finance-Recorder

A small multi-user expense tracker: sign up, record income and expenses, filter them,
and see where the money went. Server-rendered with Express 5, EJS and PostgreSQL — no
client-side framework, no build step.

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
sent over plain `http://localhost` — sign-in would silently bounce back to the login
page.

## Tests

The tests drive the real app over HTTP with `supertest` against a separate database.
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
database name ends in `_test`. It covers what is easiest to get wrong in a multi-user
app: logged-out visitors are redirected, one user's records, categories and totals
never appear on another user's page, nobody can delete or clear someone else's
records, wrong passwords are rejected, and impossible dates are a 400, not a 500.

GitHub Actions runs the same suite on every push to `main`, against a throwaway
PostgreSQL service container (`.github/workflows/test.yml`).

## Configuration

| Variable | Purpose |
| -------- | ------- |
| `DATABASE_URL` | Full connection string; takes precedence over the `PG*` variables. SSL is controlled by the string itself, e.g. `?sslmode=verify-full` |
| `PGUSER` `PGHOST` `PGDATABASE` `PGPASSWORD` `PGPORT` | Used when `DATABASE_URL` is not set |
| `SESSION_SECRET` | Signs the session cookie. Required — the app refuses to start without it |
| `NODE_ENV` | `production` marks the session cookie `Secure` |
| `APP_TIME_ZONE` | Fallback time zone for the form's default date (default `America/Los_Angeles`) |
| `PORT` | Port to listen on (default `8000`) |

## Deployment

Deployed on Render as a Docker web service, with the database on Neon:

- Render builds the `Dockerfile` and runs `node server.js` as the unprivileged `node`
  user; `.dockerignore` keeps `.env` files and tests out of the image
- `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV=production` and `APP_TIME_ZONE` are set
  in the Render dashboard, never in the repository
- Auto-deploy waits for the GitHub Actions checks to pass

## Routes

| Method | Path                   | Login | Purpose                                        |
| ------ | ---------------------- | ----- | ---------------------------------------------- |
| `GET`  | `/register`            |       | Sign-up form                                   |
| `POST` | `/register`            |       | Create an account and log in (rate limited)    |
| `GET`  | `/login`               |       | Login form                                     |
| `POST` | `/login`               |       | Log in (rate limited)                          |
| `POST` | `/logout`              |       | Destroy the session, then redirect to `/login` |
| `GET`  | `/`                    | yes   | Render the ledger; reads `?type=` `?category=` |
| `POST` | `/records`             | yes   | Create an entry, then redirect to `/`          |
| `POST` | `/records/:id/delete`  | yes   | Delete one of your entries                     |
| `POST` | `/records/delete-all`  | yes   | Clear your ledger                              |

Every write redirects instead of rendering, so a refresh never resubmits a form.

## Project structure

```
server.js            Startup: create tables, listen, shut down gracefully
app.js               The Express app: routes, queries, validation, sessions, errors
views/
  index.ejs          The ledger page
  login.ejs          Login form
  register.ejs       Sign-up form
  error.ejs          Error page
static/
  style.css
  app.js             Browser-side: auto-submit filters, confirm deletes, local date
test/
  isolation.test.js  Per-user isolation and validation tests
Dockerfile           Production image
compose.yaml         Local app + PostgreSQL
.github/workflows/   CI
```

## Design notes

### Server-side rendering over a JSON API

An earlier version was a JSON API with a client-side page that assembled the DOM
from `fetch` calls. Rewriting it as server-rendered EJS removed the hand-written HTML
escaping and the empty-state flash on first paint. The page now arrives with its data
already in it; the only browser script left is a few lines of progressive enhancement
in `static/app.js`.

The cost is a full round trip per action. For a personal ledger that is a good trade;
for something with frequent partial updates it would not be.

### Every query is scoped to the current user

`requireLogin` runs before every ledger route. It loads the user named in the session
and puts it on `req.user`; past that point, every query carries
`user_id = req.user.id`. The id always comes from the session, never from the form.

Deletes are the place this matters most. `DELETE ... WHERE id = $1 AND user_id = $2
RETURNING id` means a guessed or edited record id from someone else's ledger simply
matches nothing and becomes a 404. The tests check the totals and category lists too,
not only the record list, because a missing filter in one of the three `getStats`
queries would leak other users' numbers while every page still looked fine.

### Sessions and passwords

Passwords are hashed with bcrypt (cost 12) and never stored or logged in plain text.
Unknown emails and wrong passwords get the same message, so the login form cannot be
used to discover who has an account. Passwords over 72 bytes are rejected because
bcrypt silently ignores everything past that point.

Sessions live in PostgreSQL through `connect-pg-simple` rather than in memory, so a
restart or a free-tier sleep does not log everyone out, and logging out deletes the
server-side row so a copied cookie stops working. The session id is regenerated at
login to prevent session fixation. The cookie is `HttpOnly` and `SameSite=Lax`, which
keeps other sites from submitting the ledger's forms with your session.

### Defense in depth in the browser

`helmet` sets a Content Security Policy that only runs scripts from the site's own
files, and refuses inline event handlers. EJS already escapes everything it
interpolates; the CSP is there for the day a template slips. That is why
`static/app.js` attaches behavior through `data-autosubmit` and `data-confirm`
attributes instead of `onchange`/`onsubmit`.

Login and sign-up are rate limited per IP. Only failed logins count, so signing in
and out repeatedly never locks you out. Counters are in memory and reset on restart.

### One validation boundary

Form fields arrive as strings, and anything that can send an HTTP request can send
anything at all — a crafted `curl` call bypasses `required`, `min` and `maxlength`
without effort. `parseRecord`, `parseId` and `parseCredentials` run as the first
statement of each handler and return typed, trimmed values. Past that line, the rest
of the handler can treat its input as well-formed.

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
middleware catches them and renders the error page with that status; client errors
raised by Express itself, such as an oversized body, keep their status too. Anything
else is logged and becomes a 500. Express 5 forwards rejections from async handlers
automatically, so no route needs its own `try`/`catch`.

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

### Dates and time zones

Two PostgreSQL types need custom parsers. `DATE` would otherwise become a JS `Date`
interpreted in the server's timezone, which can shift the day; it is kept as a
`YYYY-MM-DD` string. `NUMERIC` arrives as a string to protect precision, which turns
arithmetic into string concatenation if ignored, so it is parsed to a number.
`COUNT(*)` returns `bigint` and stays a string — converted explicitly where it is
used.

The form's default date is "today" for the person filling it in, not for the server,
which runs in UTC. The server renders a fallback computed in `APP_TIME_ZONE`, and
`static/app.js` replaces it with the date on the user's own device.

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

- Rate limiting is per IP and in memory: many IPs guessing one account are not
  slowed down, and a restart resets the counters
- Categories are derived from existing rows, so deleting the last entry in a
  category removes it from the dropdowns
- Category matching is case-sensitive: `Dining` and `dining` are two categories
- No password reset or email verification
- No pagination; the ledger renders every row
