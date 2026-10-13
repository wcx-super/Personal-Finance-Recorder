import express from "express";
import pg from "pg";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import dns from "node:dns";          
import net from "node:net";          

dns.setDefaultResultOrder("ipv4first");    
net.setDefaultAutoSelectFamily(false);

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
  await db.query(`ALTER TABLE records ALTER COLUMN user_id SET NOT NULL`);
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

const MAX_AMOUNT = 9999999999.99;
const MAX_CATEGORY_LENGTH = 50;
const MAX_NOTE_LENGTH = 200;

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
  if (amount > MAX_AMOUNT) {
    throw new HttpError(400, "amount is too large");
  }
  if (typeof category !== "string" || category.trim() === "") {
    throw new HttpError(400, "category is required");
  }
  if (category.trim().length > MAX_CATEGORY_LENGTH) {
    throw new HttpError(400, `category must be at most ${MAX_CATEGORY_LENGTH} characters`);
  }
  if (String(note).trim().length > MAX_NOTE_LENGTH) {
    throw new HttpError(400, `note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  if (typeof date !== "string" || !isValidDate(date)) {
    throw new HttpError(400, "date must be a real date in YYYY-MM-DD format");
  }

  return { type, amount, category: category.trim(), note: String(note).trim(), date };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
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
  if (email.length > 254) {
    throw new HttpError(400, "email is too long");
  }
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
    throw new HttpError(401, "login required");
  }
  const { rows } = await db.query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) {
    await endSession(req);
    throw new HttpError(401, "login required");
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

app.use(helmet());


app.use(express.json({ limit: "10kb" }));


app.use(express.static("static"));
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


function tooManyRequests(req, res, next) {
  next(new HttpError(429, "too many attempts, please try again later"));
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  handler: tooManyRequests,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  handler: tooManyRequests,
});

app.post("/api/register", registerLimiter, async (req, res) => {
  const { email, password } = parseCredentials(req.body);
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email`,
    [email, passwordHash],
  );
  if (!rows[0]) {
    throw new HttpError(409, "this email is already registered");
  }
  await startSession(req, rows[0].id);
  res.status(201).json(rows[0]);
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const { email, password } = parseCredentials(req.body);
  const { rows } = await db.query(
    `SELECT id, email, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, "incorrect email or password");
  }
  await startSession(req, user.id);
  res.json({ id: user.id, email: user.email });
});

app.post("/api/logout", async (req, res) => {
  await endSession(req);
  res.clearCookie("connect.sid");
  res.sendStatus(204);
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json(req.user);
});

app.get("/api/records", requireLogin, async (req, res) => {
  const { category, type } = req.query;
  res.json(await listRecords({ userId: req.user.id, category, type }));
});

app.get("/api/stats", requireLogin, async (req, res) => {
  res.json(await getStats(req.user.id));
});

app.post("/api/records", requireLogin, async (req, res) => {
  const r = parseRecord(req.body);
  const { rows } = await db.query(
    `INSERT INTO records (type, amount, category, note, date, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [r.type, r.amount, r.category, r.note, r.date, req.user.id],
  );
  res.status(201).json(rows[0]);
});

app.delete("/api/records/:id", requireLogin, async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.query(
    `DELETE FROM records WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, req.user.id],
  );
  if (!rows[0]) {
    throw new HttpError(404, "record not found");
  }
  res.sendStatus(204);
});

app.delete("/api/records", requireLogin, async (req, res) => {
  await db.query(`DELETE FROM records WHERE user_id = $1`, [req.user.id]);
  res.sendStatus(204);
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "not found" });
});

function round2(value) {
  return Math.round(value * 100) / 100;
}


app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.detail });
  }
  if (err.expose && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

export { app, db, initDb, sessionStore };