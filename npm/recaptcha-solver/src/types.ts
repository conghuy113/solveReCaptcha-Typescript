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

export interface PuppeteerPageLike {
  /** Creates a CDP session attached to this page. */
  createCDPSession(): Promise<unknown>;
  /** Whether Puppeteer has observed this page closing. */
  isClosed(): boolean;
  /** The page's current URL. */
  url(): string;
}

interface SolveReCaptchaCommonOptions {
  /** Click the reCAPTCHA checkbox before solving the image challenge. */
  clickCheckbox: boolean;
  /** Optional per-call confidence thresholds for image challenges. */
  confidence?: SolveReCaptchaConfidenceOptions;
}

export interface SolveReCaptchaPageOptions extends SolveReCaptchaCommonOptions {
  /** Existing Puppeteer page whose current CDP connection will be reused. */
  page: PuppeteerPageLike;
  /** Optional URL assertion for the supplied page; never used to discover another tab. */
  targetUrl?: string;
  port?: never;
  browserWSEndpoint?: never;
}

export interface SolveReCaptchaPortOptions extends SolveReCaptchaCommonOptions {
  /** Full URL or stable URL fragment of the already-open target tab. */
  targetUrl: string;
  /** Chrome remote-debugging port bound on loopback. */
  port: number;
  page?: never;
  browserWSEndpoint?: never;
}

export interface SolveReCaptchaWebSocketOptions extends SolveReCaptchaCommonOptions {
  /** Full URL or stable URL fragment of the already-open target tab. */
  targetUrl: string;
  /** Existing browser's CDP endpoint: ws:// on loopback, or wss:// with verified TLS.
   * A provider launch URL does not identify a browser already opened by Puppeteer;
   * use Page mode to preserve that connection, or supply its reconnect endpoint.
   */
  browserWSEndpoint: string;
  page?: never;
  port?: never;
}

/** Exactly one connection mode must be supplied: page, browserWSEndpoint, or port. */
export type SolveReCaptchaOptions =
  | SolveReCaptchaPageOptions
  | SolveReCaptchaPortOptions
  | SolveReCaptchaWebSocketOptions;

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
