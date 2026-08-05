import { el, formatExpiry } from "../lib/dom";
import { LEGAL_NOTICE } from "../config";

function wordmark(): HTMLElement {
  return el(
    "div",
    { class: "wordmark" },
    el("span", { class: "wordmark-mark", "aria-hidden": "true" }, "U"),
    el("span", { class: "wordmark-text" }, "UnderRock"),
  );
}

function footer(): HTMLElement {
  return el(
    "footer",
    { class: "legal" },
    el("p", {}, LEGAL_NOTICE),
    el(
      "p",
      { class: "legal-links" },
      el(
        "a",
        {
          href: "https://github.com/JulianAttemptsCoding/UnderRock",
          rel: "noopener noreferrer",
          target: "_blank",
        },
        "Source",
      ),
      el("span", { "aria-hidden": "true" }, " · "),
      el(
        "a",
        {
          href: "https://github.com/JulianAttemptsCoding/UnderRock/blob/main/docs/PRIVACY.md",
          rel: "noopener noreferrer",
          target: "_blank",
        },
        "Privacy",
      ),
    ),
  );
}

type Slot = Node | string | null | undefined | false;

function shell(...children: Slot[]): HTMLElement {
  return el("div", { class: "shell" }, el("main", { class: "card" }, ...children), footer());
}

// ---------------------------------------------------------------------------

export function loadingView(message = "Starting up"): HTMLElement {
  return shell(
    wordmark(),
    el("div", { class: "spinner", role: "status", "aria-label": message }),
    el("p", { class: "muted" }, message + "…"),
  );
}

export function progressView(message: string, done: number, total: number): HTMLElement {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return shell(
    wordmark(),
    el("h1", {}, "Opening your workspace"),
    el("p", { class: "muted" }, message),
    el(
      "div",
      {
        class: "progress",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(pct),
      },
      el("div", { class: "progress-bar", style: `width:${pct}%` }),
    ),
    el("p", { class: "muted small" }, `${done} of ${total} verified`),
  );
}

export interface LandingHandlers {
  onSignIn: () => void;
}

export function landingView(handlers: LandingHandlers, error?: string | null): HTMLElement {
  const button = el(
    "button",
    { class: "btn btn-primary", type: "button", onclick: handlers.onSignIn },
    el("span", { class: "g-mark", "aria-hidden": "true" }, "G"),
    "Continue with Google",
  );

  return shell(
    wordmark(),
    el("h1", {}, "A quiet place to write LaTeX"),
    el(
      "p",
      { class: "lede" },
      "Write together in the browser. Compile on your own machine. Keep your documents " +
        "in this browser, in a local folder, or in your own Google Drive — whichever you prefer.",
    ),
    error ? el("div", { class: "alert alert-error", role: "alert" }, error) : null,
    button,
    el(
      "p",
      { class: "muted small" },
      "Sign-in is limited to people the site owner has added. UnderRock asks Google only " +
        "for your name, email address, and profile picture. It never sees your password, " +
        "and it does not request access to your files at sign-in.",
    ),
    el(
      "ul",
      { class: "feature-list" },
      el("li", {}, "Real-time collaborative editing"),
      el("li", {}, "pdfLaTeX, XeLaTeX and LuaLaTeX on your own computer"),
      el("li", {}, "Track changes, comments, and full project history"),
      el("li", {}, "Nothing to pay, ever"),
    ),
  );
}

export interface PasswordHandlers {
  onSubmit: (password: string) => void;
  onSignOut: () => void;
}

export function passwordView(
  email: string,
  handlers: PasswordHandlers,
  state: { error?: string | null; busy?: boolean; lockedMinutes?: number | null } = {},
): HTMLElement {
  const input = el("input", {
    class: "input",
    type: "password",
    id: "site-password",
    name: "site-password",
    autocomplete: "current-password",
    required: true,
    "aria-describedby": "password-help",
    disabled: state.busy === true,
  });

  const form = el(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        const value = input.value;
        if (value.length > 0) handlers.onSubmit(value);
      },
    },
    el("label", { class: "label", for: "site-password" }, "Access password"),
    input,
    el(
      "p",
      { id: "password-help", class: "muted small" },
      "The site owner shares this with the ten people who may use UnderRock. " +
        "It is checked on the server; typing it here is the only way in.",
    ),
    el(
      "button",
      { class: "btn btn-primary", type: "submit", disabled: state.busy === true },
      state.busy ? "Checking…" : "Unlock",
    ),
  );

  return shell(
    wordmark(),
    el("h1", {}, "One more step"),
    el("p", { class: "muted" }, `Signed in as ${email}`),
    state.lockedMinutes
      ? el(
          "div",
          { class: "alert alert-error", role: "alert" },
          `Too many attempts. Try again in about ${state.lockedMinutes} minutes.`,
        )
      : null,
    state.error && !state.lockedMinutes
      ? el("div", { class: "alert alert-error", role: "alert" }, state.error)
      : null,
    form,
    el(
      "button",
      { class: "btn btn-quiet", type: "button", onclick: handlers.onSignOut },
      "Use a different account",
    ),
  );
}

export interface ErrorHandlers {
  onRetry?: () => void;
  onSignOut?: () => void;
}

export function errorView(
  title: string,
  detail: string,
  handlers: ErrorHandlers = {},
): HTMLElement {
  return shell(
    wordmark(),
    el("h1", {}, title),
    el("pre", { class: "detail" }, detail),
    el(
      "div",
      { class: "row" },
      handlers.onRetry
        ? el(
            "button",
            { class: "btn btn-primary", type: "button", onclick: handlers.onRetry },
            "Try again",
          )
        : null,
      handlers.onSignOut
        ? el(
            "button",
            { class: "btn btn-quiet", type: "button", onclick: handlers.onSignOut },
            "Sign out",
          )
        : null,
    ),
  );
}

export function notConfiguredView(detail: string): HTMLElement {
  return shell(
    wordmark(),
    el("h1", {}, "Not configured yet"),
    el(
      "p",
      { class: "lede" },
      "This site has been deployed but has not been pointed at a Supabase project.",
    ),
    el("pre", { class: "detail" }, detail),
    el(
      "p",
      { class: "muted small" },
      "The site owner needs to set the VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
        "repository variables and re-run the deploy workflow. Step-by-step instructions " +
        "are in SETUP_EVERYTHING_NONTECHNICAL.md.",
    ),
  );
}

export function lockedOutView(expiresAt: string | null, onSignOut: () => void): HTMLElement {
  return shell(
    wordmark(),
    el("h1", {}, "Session locked"),
    el(
      "p",
      { class: "muted" },
      expiresAt
        ? `Your access expired at ${formatExpiry(expiresAt)}.`
        : "Your access has been revoked.",
    ),
    el("button", { class: "btn btn-quiet", type: "button", onclick: onSignOut }, "Sign out"),
  );
}
