import { createInterface } from "node:readline";
import { log } from "../logger";
import { PinGuard } from "./pin";

function ask(question: string, opts: { mute?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    // Mask PIN input: intercept writes to the output while answering.
    const output = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
    if (opts.mute && output.output) {
      output._writeToOutput = (s: string) => {
        if (s.includes(question)) output.output!.write(s);
        else output.output!.write("*");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (opts.mute) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * Ensures a connection PIN is configured before the host starts accepting controllers.
 *
 * Resolution order:
 *  1. already persisted   -> keep it (TTY confirms reuse; non-TTY keeps it silently).
 *  2. interactive TTY     -> prompt to create one (masked).
 *  3. no TTY, nothing set -> run without a PIN, with a loud warning.
 */
export async function ensurePin(stateDir: string): Promise<PinGuard> {
  const guard = PinGuard.load(stateDir);

  if (process.stdin.isTTY) {
    if (guard.isSet) {
      const reuse = (await ask("  Reuse previous connection PIN? [Y/n]: ")).trim().toLowerCase();
      if (reuse === "" || reuse === "y" || reuse === "yes") {
        log.info("connection PIN reused");
        return guard;
      }
    }

    console.log("");
    console.log("  Set a connection PIN (>= 4 chars). Controllers must enter it to connect.");
    for (;;) {
      const pin = await ask("  New PIN: ", { mute: true });
      if (pin.length < 4) {
        console.log("  Too short — at least 4 characters.");
        continue;
      }
      guard.setPin(pin);
      log.info("connection PIN set");
      break;
    }
    return guard;
  }

  if (guard.isSet) {
    log.info("connection PIN loaded");
    return guard;
  }

  log.warn("no terminal and no saved PIN — running WITHOUT a connection PIN.");
  log.warn("run the agent once in a terminal to set a PIN.");
  return guard;
}
