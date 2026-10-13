import { api } from "./api.js";

const DEFAULT_CATS = ["Dining", "Transportation", "Shopping", "Housing", "Entertainment", "Salary"];
const filters = new URLSearchParams(location.search);
const form = document.getElementById("add-form");
const formError = document.getElementById("form-error");

function fmt(value) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function handleError(err) {
  if (err.status === 401) {
    location.href = "/login.html";
    return;
  }
  alert(err.message);
}

function renderSummary(stats) {
  document.getElementById("balance").textContent = fmt(stats.balance);
  document.getElementById("total-income").textContent = fmt(stats.total_income);
  document.getElementById("total-expense").textContent = fmt(stats.total_expense);
  const clearAll = document.getElementById("clear-all");
  clearAll.disabled = stats.count === 0;
  clearAll.dataset.count = stats.count;
}

function renderCategoryOptions(stats) {
  const suggestions = [...new Set([...DEFAULT_CATS, ...stats.all_categories])].sort();
  document.getElementById("cats").replaceChildren(
    ...suggestions.map((cat) => {
      const option = document.createElement("option");
      option.value = cat;
      return option;
    }),
  );

  const categorySelect = document.getElementById("filter-category");
  categorySelect.replaceChildren(
    new Option("All Categories", ""),
    ...stats.all_categories.map((cat) => new Option(cat, cat)),
  );
  categorySelect.value = filters.get("category") ?? "";
  document.getElementById("filter-type").value = filters.get("type") ?? "";
}

function renderRecords(records) {
  const list = document.getElementById("records");
  if (records.length === 0) {
    list.replaceChildren(el("div", "empty", "No transactions to display."));
    return;
  }
  list.replaceChildren(
    ...records.map((r) => {
      const label = el("span", null, r.category);
      if (r.note) label.append(" ", el("span", "note", r.note));

      const del = el("button", "del", "×");
      del.type = "button";
      del.title = "Delete";
      del.addEventListener("click", () => deleteRecord(r.id));
      const delCell = el("span", "del-form");
      delCell.append(del);

      const row = el("div", "row");
      row.append(
        el("span", "date num", r.date.slice(5)),
        label,
        el("span", `money num ${r.type}`, `${r.type === "income" ? "+" : "−"}${fmt(r.amount)}`),
        delCell,
      );
      return row;
    }),
  );
}

function renderCategories(stats) {
  const box = document.getElementById("categories");
  const cats = Object.entries(stats.expense_by_category).sort((a, b) => b[1] - a[1]);
  if (cats.length === 0) {
    box.replaceChildren(el("div", "empty", "No expense records."));
    return;
  }
  const max = cats[0][1];
  box.replaceChildren(
    ...cats.map(([cat, total]) => {
      const fill = el("span");
      fill.style.width = `${((total / max) * 100).toFixed(1)}%`;
      const bar = el("span", "bar");
      bar.append(fill);
      const amount = el("span", "num", fmt(total));
      amount.style.textAlign = "right";

      const row = el("div", "cat");
      row.append(el("span", null, cat), bar, amount);
      return row;
    }),
  );
}

async function load() {
  const [records, stats] = await Promise.all([
    api(`/records?${filters}`),
    api("/stats"),
  ]);
  renderSummary(stats);
  renderCategoryOptions(stats);
  renderRecords(records);
  renderCategories(stats);
}

async function deleteRecord(id) {
  if (!confirm("Delete this transaction?")) return;
  try {
    await api(`/records/${id}`, { method: "DELETE" });
    await load();
  } catch (err) {
    handleError(err);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.hidden = true;
  try {
    await api("/records", { method: "POST", body: Object.fromEntries(new FormData(form)) });
    form.reset();
    form.elements.date.value = localToday();
    await load();
  } catch (err) {
    if (err.status === 401) return handleError(err);
    formError.textContent = err.message;
    formError.hidden = false;
  }
});

for (const select of document.querySelectorAll(".filter-form select")) {
  select.addEventListener("change", () => select.form.requestSubmit());
}

document.getElementById("clear-all").addEventListener("click", async (event) => {
  const count = event.currentTarget.dataset.count;
  if (!confirm(`Delete all ${count} transactions? This action cannot be undone.`)) return;
  try {
    await api("/records", { method: "DELETE" });
    await load();
  } catch (err) {
    handleError(err);
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  location.href = "/login.html";
});

try {
  const me = await api("/me");
  document.getElementById("user-email").textContent = me.email;
  form.elements.date.value = localToday();
  await load();
} catch (err) {
  handleError(err);
}