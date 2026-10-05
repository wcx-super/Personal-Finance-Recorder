import { app, db, initDb, sessionStore } from "./app.js";
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