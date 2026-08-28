export interface SolveReCaptchaConfidenceOptions {
  /** Minimum target-class score required for each of the top three 3x3 tiles. */
  classificationMinConfidence?: number;
  /** Minimum target-class score required to retain a 4x4 detection box. */
  detectionConfidence?: number;
}

export interface SolveReCaptchaConfidence {
  /** Classification threshold explicitly supplied for this solve. */
  classificationMinConfidence?: number;
  /** Detection threshold explicitly supplied for this solve. */
  detectionConfidence?: number;
}

export interface SolveReCaptchaOptions {
  /** Full URL or stable URL fragment of the already-open target tab. */
  targetUrl: string;
  /** Chrome remote-debugging port bound on 127.0.0.1. */
  port: number;
  /** Click the reCAPTCHA checkbox before solving the image challenge. */
  clickCheckbox: boolean;
  /** Optional per-call confidence thresholds for image challenges. */
  confidence?: SolveReCaptchaConfidenceOptions;
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

export type SolveVerification =
  | "widget_and_token_confirmed"
  | "navigation_confirmed"
  | "token_observed"
  | "widget_observed";

export type CaptchaType =
  | "dynamic_3x3"
  | "selection_3x3"
  | "square_4x4"
  | "no_challenge";

export interface SolveReCaptchaResult {
  status: "success" | "unverified";
  message: string;
  clickCheckbox: boolean;
  token: string | null;
  captchaType: CaptchaType;
  attempts: number;
  timeTaken: number;
  cookies: BrowserCookie[];
  currentUrl: string;
  completionReason: CompletionReason;
  /** Evidence used to classify this result as successful or unverified. */
  verification: SolveVerification;
  /** Explicit threshold overrides, omitted when no model was used or no override was supplied. */
  confidence?: SolveReCaptchaConfidence;
}
