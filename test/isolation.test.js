import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, db, initDb, sessionStore } from "../app.js";

let alice;
let bob;
let aliceRecordId;

before(async () => {
  const { rows } = await db.query("SELECT current_database() AS name");
  if (!rows[0].name.endsWith("_test")) {
    throw new Error(`refusing to run tests against database "${rows[0].name}"`);
  }

  await initDb();
  await db.query("DELETE FROM records");
  await db.query("DELETE FROM users");

  alice = request.agent(app);
  bob = request.agent(app);
  await alice.post("/api/register").send({ email: "alice@example.com", password: "alice-password" }).expect(201);
  await bob.post("/api/register").send({ email: "bob@example.com", password: "bob-password" }).expect(201);
});

after(async () => {
  sessionStore.close();
  await db.end();
});

test("API calls without a session get 401", async () => {
  const res = await request(app).get("/api/records").expect(401);
  assert.equal(res.body.error, "login required");
});

test("users only see their own records", async () => {
  const created = await alice
    .post("/api/records")
    .send({ type: "expense", amount: "12.50", category: "alice-category", note: "alice-lunch", date: "2026-10-01" })
    .expect(201);
  aliceRecordId = created.body.id;

  const aliceList = await alice.get("/api/records").expect(200);
  assert.deepEqual(aliceList.body.map((r) => r.id), [aliceRecordId]);

  const bobList = await bob.get("/api/records").expect(200);
  assert.deepEqual(bobList.body, []);
});

test("stats never include another user's records", async () => {
  const res = await bob.get("/api/stats").expect(200);
  assert.equal(res.body.balance, 0);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.expense_by_category, {});
  assert.deepEqual(res.body.all_categories, []);
});

test("a user cannot delete someone else's record", async () => {
  await bob.delete(`/api/records/${aliceRecordId}`).expect(404);

  const stillThere = await db.query("SELECT id FROM records WHERE id = $1", [aliceRecordId]);
  assert.equal(stillThere.rows.length, 1);
});

test("clearing the ledger only clears your own records", async () => {
  await bob.delete("/api/records").expect(204);

  const aliceList = await alice.get("/api/records").expect(200);
  assert.equal(aliceList.body.length, 1);
});

test("a wrong password is rejected", async () => {
  const res = await request(app)
    .post("/api/login")
    .send({ email: "alice@example.com", password: "not-her-password" })
    .expect(401);
  assert.equal(res.body.error, "incorrect email or password");
});

test("an impossible date is rejected with 400, not 500", async () => {
  const res = await alice
    .post("/api/records")
    .send({ type: "expense", amount: "5", category: "Test", note: "", date: "2026-02-30" })
    .expect(400);
  assert.match(res.body.error, /date/);
});

test("logging out ends the session", async () => {
  await alice.post("/api/logout").expect(204);
  await alice.get("/api/me").expect(401);
});