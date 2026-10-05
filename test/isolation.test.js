import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, db, initDb, sessionStore } from "../app.js";

let alice;
let bob;

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
  await alice
    .post("/register")
    .type("form")
    .send({ email: "alice@example.com", password: "alice-password" })
    .expect(302);
  await bob
    .post("/register")
    .type("form")
    .send({ email: "bob@example.com", password: "bob-password" })
    .expect(302);
});

after(async () => {
  sessionStore.close();
  await db.end();
});

test("visitors who are not logged in are sent to the login page", async () => {
  await request(app).get("/").expect(302).expect("Location", "/login");
});

test("users only see their own records", async () => {
  await alice
    .post("/records")
    .type("form")
    .send({ type: "expense", amount: "12.50", category: "alice-category", note: "alice-lunch", date: "2026-10-01" })
    .expect(302);

  const alicePage = await alice.get("/").expect(200);
  assert.match(alicePage.text, /alice-lunch/);

  const bobPage = await bob.get("/").expect(200);
  assert.doesNotMatch(bobPage.text, /alice-lunch/);
  assert.doesNotMatch(bobPage.text, /alice-category/);
  assert.match(bobPage.text, /class="balance num">0\.00</);
});

test("a user cannot delete someone else's record", async () => {
  const { rows } = await db.query("SELECT id FROM records WHERE note = 'alice-lunch'");
  const id = rows[0].id;

  await bob.post(`/records/${id}/delete`).expect(404);

  const stillThere = await db.query("SELECT id FROM records WHERE id = $1", [id]);
  assert.equal(stillThere.rows.length, 1);
});

test("clearing the ledger only clears your own records", async () => {
  await bob.post("/records/delete-all").expect(302);

  const { rows } = await db.query("SELECT id FROM records WHERE note = 'alice-lunch'");
  assert.equal(rows.length, 1);
});

test("a wrong password is rejected", async () => {
  await request(app)
    .post("/login")
    .type("form")
    .send({ email: "alice@example.com", password: "not-her-password" })
    .expect(401);
});

test("an impossible date is rejected with 400, not 500", async () => {
  await alice
    .post("/records")
    .type("form")
    .send({ type: "expense", amount: "5", category: "Test", note: "", date: "2026-02-30" })
    .expect(400);
});