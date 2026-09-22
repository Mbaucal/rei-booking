import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function ask(label, { secret = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run setup in your own interactive terminal.");
  const controller = new AbortController();
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!secret) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  rl.on("SIGINT", () => controller.abort());
  try {
    if (secret) process.stdout.write(label);
    return await rl.question(secret ? "" : label, {
      signal: controller.signal,
    });
  } finally {
    rl.close();
    output.destroy();
    if (secret) process.stdout.write("\n");
  }
}
