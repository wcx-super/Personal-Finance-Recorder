import { parentPort } from "node:worker_threads";
import bcrypt from "bcryptjs";

parentPort.on("message", ({ op, args }) => {
  try {
    const result = op === "hash" ? bcrypt.hashSync(...args) : bcrypt.compareSync(...args);
    parentPort.postMessage({ result });
  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
});