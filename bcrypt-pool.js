import { Worker } from "node:worker_threads";
import os from "node:os";

const WORKER_URL = new URL("./bcrypt-worker.js", import.meta.url);

export function createBcryptPool(size = Math.max(1, os.availableParallelism() - 1)) {
  const workers = new Set();
  const idle = [];
  const queue = [];
  const current = new Map();
  let closing = false;

  function spawn() {
    const worker = new Worker(WORKER_URL);
    workers.add(worker);

    worker.on("message", ({ result, error }) => {
      const task = current.get(worker);
      current.delete(worker);
      if (error) {
        task.reject(new Error(error));
      } else {
        task.resolve(result);
      }
      release(worker);
    });

    worker.on("error", (err) => {
      current.get(worker)?.reject(err);
      current.delete(worker);
      workers.delete(worker);
      const i = idle.indexOf(worker);
      if (i !== -1) idle.splice(i, 1);
      if (!closing) spawn();
    });

    release(worker);
  }

  function run(worker, task) {
    current.set(worker, task);
    worker.postMessage({ op: task.op, args: task.args });
  }

  function release(worker) {
    const next = queue.shift();
    if (next) {
      run(worker, next);
    } else {
      idle.push(worker);
    }
  }

  function exec(op, args) {
    return new Promise((resolve, reject) => {
      if (closing) {
        reject(new Error("bcrypt pool is closed"));
        return;
      }
      const task = { op, args, resolve, reject };
      const worker = idle.pop();
      if (worker) {
        run(worker, task);
      } else {
        queue.push(task);
      }
    });
  }

  for (let i = 0; i < size; i++) {
    spawn();
  }

  return {
    hash: (password, cost) => exec("hash", [password, cost]),
    compare: (password, hash) => exec("compare", [password, hash]),
    async close() {
      closing = true;
      for (const task of queue.splice(0)) {
        task.reject(new Error("bcrypt pool is closed"));
      }
      await Promise.all([...workers].map((worker) => worker.terminate()));
    },
  };
}
