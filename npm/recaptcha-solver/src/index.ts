import { WorkerClient } from "./worker-client.js";

import type { SolveReCaptchaOptions, SolveReCaptchaResult } from "./types.js";

let worker: WorkerClient | undefined;

function getWorker(): WorkerClient {
  if (!worker) {
    worker = new WorkerClient();
    worker.on("log", (message: string) => process.stderr.write(message));
  }
  return worker;
}

/** Solve reCAPTCHA in an already-open Chrome tab. */
export async function solveReCaptcha(
  options: SolveReCaptchaOptions,
): Promise<SolveReCaptchaResult> {
  return getWorker().solveReCaptcha(options);
}

process.once("exit", () => worker?.close());

export type {
  BrowserCookie,
  CompletionReason,
  SolveReCaptchaOptions,
  SolveReCaptchaResult,
} from "./types.js";
