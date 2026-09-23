# Personal-Finance-Recorder


A small personal expense tracker: record income and expenses, filter them, and see
where the money went. Server-rendered with Express 5, EJS and PostgreSQL — no
client-side framework, no build step.

## Features

- Add income/expense entries with amount, category, date and an optional note
- Filter the ledger by type and category; filters live in the URL, so they survive
  refresh, back/forward and bookmarking
- Running balance, income/expense totals, and a per-category expense breakdown
- Category suggestions that grow from what you have actually used
- Delete a single entry or clear the ledger

## Requirements

- Node.js 20.6 or newer (uses the built-in `--env-file` flag, so there is no `dotenv` dependency)
- PostgreSQL 9.4 or newer (uses aggregate `FILTER`)

## Setup

```bash
git clone <your-repo-url>
cd accounting_notebook
npm install
```

Create the database:

```bash
createdb ledger
```

Copy the example environment file and fill in your PostgreSQL password:

```bash
cp .env.example .env
```

```ini
PGUSER=postgres
PGHOST=localhost
PGDATABASE=ledger
PGPASSWORD=your-password-here
PGPORT=5432
PORT=8000
```

Run it:

```bash
npm run dev     # with --watch, restarts on file changes
npm start       # plain
```

Then open <http://localhost:8000>.

The `records` table and its indexes are created on startup if they do not exist, so
there is no separate migration step.

## Routes

| Method | Path                   | Purpose                                      |
| ------ | ---------------------- | -------------------------------------------- |
| `GET`  | `/`                    | Render the ledger; reads `?type=` `?category=` |
| `POST` | `/records`             | Create an entry, then redirect to `/`         |
| `POST` | `/records/:id/delete`  | Delete one entry, then redirect to `/`        |
| `POST` | `/records/delete-all`  | Clear the ledger, then redirect to `/`        |

Every write redirects instead of rendering, so a refresh never resubmits a form.

## Project structure

```
server.js          Routes, queries, validation, error handling
views/
  index.ejs        The ledger page
  error.ejs        Error page
static/
  style.css        Served by express.static
```

## Design notes

### Server-side rendering over a JSON API

An earlier version was a JSON API with a client-side page that assembled the DOM
from `fetch` calls. Rewriting it as server-rendered EJS removed the entire
client-side script, the hand-written HTML escaping, and the empty-state flash on
first paint. The page now arrives with its data already in it.

The cost is a full round trip per action. For a single-user ledger that is a good
trade; for something with frequent partial updates it would not be.

### One validation boundary

Form fields arrive as strings, and anything that can send an HTTP request can send
anything at all — a crafted `curl` call bypasses `required` and `min` attributes
without effort. `parseRecord` and `parseId` run as the first statement of each
handler and return typed, trimmed values. Past that line, the rest of the handler
can treat its input as well-formed.

The checks are not decorative. PostgreSQL's `NUMERIC` accepts `NaN` as a legitimate
value, so an unvalidated `Number("abc")` inserts cleanly and then poisons every
`SUM` that touches it. `TEXT` columns accept any `type` string, so a bogus value
would be invisible to both `FILTER (WHERE type = 'income')` and its expense
counterpart — the money would silently vanish from the totals while still showing
in the list.

### Typed errors, one handler

Validation failures `throw new HttpError(status, detail)`. A single Express error
middleware catches them and renders the error page with that status; anything else
is logged and becomes a 500. Express 5 forwards rejections from async handlers
automatically, so no route needs its own `try`/`catch`.

The point of the distinction is honesty: a 400 tells the user to fix their input, a
500 admits the server is broken. Letting a bad amount surface as a 500 would blame
the wrong party.

### Parameterized queries, including the dynamic ones

Values always travel as `$1`-style parameters, never string interpolation. The
filtered list needs a `WHERE` clause whose shape is not known until runtime, so
conditions and parameters are accumulated in two parallel arrays:

```js
if (category) {
  params.push(category);
  where.push(`category = $${params.length}`);
}
```

Pushing the value first means `params.length` is already the 1-based index that
PostgreSQL's placeholder numbering expects. The SQL *structure* is assembled in
JavaScript; the *values* are never part of that string.

### Type coercion at the driver boundary

Two PostgreSQL types need custom parsers. `DATE` would otherwise become a JS `Date`
interpreted in the server's timezone, which can shift the day; it is kept as a
`YYYY-MM-DD` string. `NUMERIC` arrives as a string to protect precision, which turns
arithmetic into string concatenation if ignored, so it is parsed to a number.
`COUNT(*)` returns `bigint` and stays a string — converted explicitly where it is
used.

### Connection pool

`getStats` issues three aggregate queries through `Promise.all`. A single `Client`
serializes them on one connection — pg 8 queues them with a deprecation warning, and
pg 9 will refuse. A `Pool` hands each query its own connection and runs them
concurrently.

One consequence worth naming: those three queries see three independent snapshots,
so a concurrent write could make the totals and the category breakdown disagree by
one entry. A transaction would fix it at the cost of giving up the concurrency. For
a single-user ledger it is not worth it.

## Known limitations

- No authentication — anything that can reach the port can read and edit the ledger
- Categories are derived from existing rows, so deleting the last entry in a
  category removes it from the dropdowns
- Category matching is case-sensitive: `Dining` and `dining` are two categories
- No pagination; the ledger renders every row


