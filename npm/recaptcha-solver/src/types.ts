export interface SolveReCaptchaOptions {
  /** Full URL or stable URL fragment of the already-open target tab. */
  targetUrl: string;
  /** Chrome remote-debugging port bound on 127.0.0.1. */
  port: number;
  /** Click the reCAPTCHA checkbox before solving the image challenge. */
  clickCheckbox: boolean;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [key: string]: unknown;
}

export type CompletionReason =
  | "token_found"
  | "url_changed"
  | "checkbox_solved";

export interface SolveReCaptchaResult {
  status: "success";
  message: string;
  clickCheckbox: boolean;
  token: string | null;
  captchaType: string;
  attempts: number;
  timeTaken: number;
  cookies: BrowserCookie[];
  currentUrl: string;
  completionReason: CompletionReason;
}

export interface WorkerErrorPayload {
  code: string;
  message: string;
  type: string;
  details?: Record<string, unknown>;
}
