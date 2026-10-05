import path from "node:path";
import express from "express";
import pg from "pg";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";

const db = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        user: process.env.PGUSER || "postgres",
        host: process.env.PGHOST || "localhost",
        database: process.env.PGDATABASE || "ledger",
        password: process.env.PGPASSWORD,
        port: Number(process.env.PGPORT) || 5432,
      },
);

db.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
});

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is not set");
}

pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1700, (value) => parseFloat(value));

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS records (
      id       SERIAL PRIMARY KEY,
      type     TEXT NOT NULL,
      amount   NUMERIC(12, 2) NOT NULL,
      category TEXT NOT NULL,
      note     TEXT NOT NULL DEFAULT '',
      date     DATE NOT NULL
    )
  `);
  await db.query(`
    ALTER TABLE records
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_records_category ON records (category)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_records_date ON records (date)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_records_user_date ON records (user_id, date)`);
}

const VALID_TYPES = ["income", "expense"];

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

function parseRecord(body = {}) {
  const { type, category, date } = body;
  const note = body.note ?? "";
  const amount = Number(body.amount);

  if (!VALID_TYPES.includes(type)) {
    throw new HttpError(400, `type must be ${VALID_TYPES}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, "amount must be greater than 0");
  }
  if (typeof category !== "string" || category.trim() === "") {
    throw new HttpError(400, "category is required");
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError(400, "date must be in YYYY-MM-DD format");
  }

  return { type, amount, category: category.trim(), note: String(note).trim(), date };
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id)) {
    throw new HttpError(400, "record id must be an integer");
  }
  return id;
}

function parseCredentials(body = {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new HttpError(400, "a valid email is required");
  }
  if (password.length < 8) {
    throw new HttpError(400, "password must be at least 8 characters");
  }
  if (Buffer.byteLength(password) > 72) {
    throw new HttpError(400, "password is too long");
  }

  return { email, password };
}

function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      resolve();
    });
  });
}

function endSession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

async function requireLogin(req, res, next) {
  const userId = req.session.userId;
  if (!userId) {
    return res.redirect("/login");
  }
  const { rows } = await db.query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) {
    await endSession(req);
    return res.redirect("/login");
  }
  req.user = rows[0];
  next();
}

async function listRecords({ userId, category, type }) {
  const where = ["user_id = $1"];
  const params = [userId];
  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  if (type) {
    params.push(type);
    where.push(`type = $${params.length}`);
  }

  const { rows } = await db.query(
    `SELECT * FROM records
     WHERE ${where.join(" AND ")}
     ORDER BY date DESC, id DESC`,
    params,
  );
  return rows;
}

async function getStats(userId) {
  const [totals, byCategory, categories] = await Promise.all([
    db.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)  AS income,
        COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expense,
        COUNT(*) AS count
      FROM records
      WHERE user_id = $1
    `, [userId]),
    db.query(`
      SELECT category, SUM(amount) AS total
      FROM records
      WHERE user_id = $1 AND type = 'expense'
      GROUP BY category
    `, [userId]),
    db.query(`SELECT DISTINCT category FROM records WHERE user_id = $1 ORDER BY category`, [userId]),
  ]);

  const income = Number(totals.rows[0].income);
  const expense = Number(totals.rows[0].expense);

  return {
    total_income: round2(income),
    total_expense: round2(expense),
    balance: round2(income - expense),
    count: Number(totals.rows[0].count),
    expense_by_category: Object.fromEntries(
      byCategory.rows.map((row) => [row.category, round2(Number(row.total))]),
    ),
    all_categories: categories.rows.map((row) => row.category),
  };
}

const app = express();

app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.use("/static", express.static("static"));
const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({ pool: db, createTableIfMissing: true });

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

const DEFAULT_CATS = ["Dining", "Transportation", "Shopping", "Housing", "Entertainment", "Salary"];

app.get("/register", (req, res) => {
  res.render("register.ejs");
});

app.post("/register", async (req, res) => {
  const { email, password } = parseCredentials(req.body);
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, passwordHash],
  );
  if (!rows[0]) {
    throw new HttpError(409, "this email is already registered");
  }
  await startSession(req, rows[0].id);
  res.redirect("/");
});

app.get("/login", (req, res) => {
  res.render("login.ejs");
});

app.post("/login", async (req, res) => {
  const { email, password } = parseCredentials(req.body);
  const { rows } = await db.query(
    `SELECT id, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, "incorrect email or password");
  }
  await startSession(req, user.id);
  res.redirect("/");
});

app.post("/logout", async (req, res) => {
  await endSession(req);
  res.clearCookie("connect.sid");
  res.redirect("/login");
});

app.get("/", requireLogin, async (req, res) => {
  const { category, type } = req.query;

  const [records, stats] = await Promise.all([
    listRecords({ userId: req.user.id, category, type }),
    getStats(req.user.id),
  ]);

  res.render("index.ejs", {
    records,
    stats,
    user: req.user,
    filters: { category, type },
    catOptions: [...new Set([...DEFAULT_CATS, ...stats.all_categories])].sort(),
    today: today(),
    fmt,
  });
});

app.post("/records", requireLogin, async (req, res) => {
  const r = parseRecord(req.body);
  await db.query(
    `INSERT INTO records (type, amount, category, note, date, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [r.type, r.amount, r.category, r.note, r.date, req.user.id],
  );
  res.redirect("/");
});

app.post("/records/:id/delete", requireLogin, async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.query(
    `DELETE FROM records WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, req.user.id],
  );
  if (!rows[0]) {
    throw new HttpError(404, "record not found");
  }
  res.redirect("/");
});

app.post("/records/delete-all", requireLogin, async (req, res) => {
  await db.query(`DELETE FROM records WHERE user_id = $1`, [req.user.id]);
  res.redirect("/");
});

function round2(value) {
  return Math.round(value * 100) / 100;
}

function fmt(value) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const TIME_ZONE = process.env.APP_TIME_ZONE || "America/Los_Angeles";

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).render("error.ejs", {
      status: err.status,
      detail: err.detail,
    });
  }
  console.error(err);
  res.status(500).render("error.ejs", {
    status: 500,
    detail: "internal server error",
  });
});

const PORT = Number(process.env.PORT) || 8000;

await initDb();
const server = app.listen(PORT, () => {
  console.log(`Ledger running at http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    sessionStore.close();
    await db.end();
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);