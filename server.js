import path from "node:path";
import express from "express";
import pg from "pg";

const db = new pg.Pool({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "ledger",
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT) || 5432,
});

pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1700, (value) => parseFloat(value));

async function initDb() {
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
  await db.query(`CREATE INDEX IF NOT EXISTS idx_records_category ON records (category)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_records_date ON records (date)`);
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

async function listRecords({ category, type }) {
  const where = [];
  const params = [];
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
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY date DESC, id DESC`,
    params,
  );
  return rows;
}

async function getStats() {
  const [totals, byCategory, categories] = await Promise.all([
    db.query(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)  AS income,
        COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS expense,
        COUNT(*) AS count
      FROM records
    `),
    db.query(`
      SELECT category, SUM(amount) AS total
      FROM records
      WHERE type = 'expense'
      GROUP BY category
    `),
    db.query(`SELECT DISTINCT category FROM records ORDER BY category`),
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

app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.resolve("views"));

app.use("/static", express.static("static"));

const DEFAULT_CATS = ["Dining", "Transportation", "Shopping", "Housing", "Entertainment", "Salary"];

app.get("/", async (req, res) => {
  const { category, type } = req.query;

  const [records, stats] = await Promise.all([
    listRecords({ category, type }),
    getStats(),
  ]);

  res.render("index.ejs", {
    records,
    stats,
    filters: { category, type },
    catOptions: [...new Set([...DEFAULT_CATS, ...stats.all_categories])].sort(),
    today: today(),
    fmt,
  });
});

app.post("/records", async (req, res) => {
  const r = parseRecord(req.body);
  await db.query(
    `INSERT INTO records (type, amount, category, note, date)
     VALUES ($1, $2, $3, $4, $5)`,
    [r.type, r.amount, r.category, r.note, r.date],
  );
  res.redirect("/");
});

app.post("/records/:id/delete", async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await db.query(
    `DELETE FROM records WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!rows[0]) {
    throw new HttpError(404, "record not found");
  }
  res.redirect("/");
});

app.post("/records/delete-all", async (req, res) => {
  await db.query(`DELETE FROM records`);
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

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
app.listen(PORT, () => {
  console.log(`Ledger running at http://localhost:${PORT}`);
});
