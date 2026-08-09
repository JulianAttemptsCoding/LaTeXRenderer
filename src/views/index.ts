import { el, formatExpiry } from "../lib/dom";
import { LEGAL_NOTICE } from "../config";

function wordmark(): HTMLElement {
  return el(
    "div",
    { class: "wordmark" },
    el("span", { class: "wordmark-mark", "aria-hidden": "true" }, "L"),
    el("span", { class: "wordmark-text" }, "LaTeXRenderer"),
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
          href: "https://github.com/JulianAttemptsCoding/LaTeXRenderer",
          rel: "noopener noreferrer",
          target: "_blank",
        },
        "Source",
      ),
      el("span", { "aria-hidden": "true" }, " · "),
      el(
        "a",
        {
          href: "https://github.com/JulianAttemptsCoding/LaTeXRenderer/blob/main/docs/PRIVACY.md",
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
    el("p", { class: "mission" }, "Making LaTeX free and open."),
    el("div", { class: "spinner", role: "status", "aria-label": message }),
    el("p", { class: "muted small" }, message + "…"),
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

/** The node Google Identity Services renders its own button into, in direct mode. */
export const GOOGLE_BUTTON_ID = "google-signin-host";

export function landingView(
  handlers: LandingHandlers,
  error?: string | null,
  options: { renderGoogleButton?: boolean } = {},
): HTMLElement {
  // In direct mode Google renders its own button, which its branding rules require and
  // which is also the only reliable way to open the popup. A fallback button is kept
  // underneath so the page is never a dead end if the script is blocked.
  const button = options.renderGoogleButton
    ? el(
        "div",
        { class: "signin-slot" },
        el("div", { id: GOOGLE_BUTTON_ID }),
        el(
          "button",
          { class: "btn btn-quiet", type: "button", onclick: handlers.onSignIn },
          "Continue with Google",
        ),
      )
    : el(
        "button",
        { class: "btn btn-primary", type: "button", onclick: handlers.onSignIn },
        el("span", { class: "g-mark", "aria-hidden": "true" }, "G"),
        "Continue with Google",
      );

  return shell(
    wordmark(),
    el("h1", {}, "Make LaTeX free and open"),
    el(
      "p",
      { class: "lede" },
      "Good writing tools should not sit behind a subscription. LaTeXRenderer is a full " +
        "LaTeX workspace that costs nothing to run and nothing to use — because the " +
        "editor lives in your browser and the typesetting happens on your own computer.",
    ),
    error ? el("div", { class: "alert alert-error", role: "alert" }, error) : null,
    button,
    el(
      "p",
      { class: "muted small" },
      "We ask Google only for your name, email, and picture. Never your password, " +
        "and never your files.",
    ),
    el(
      "ul",
      { class: "feature-list" },
      el("li", {}, "Write together, in real time"),
      el("li", {}, "Compile on your machine — nothing is uploaded"),
      el("li", {}, "Your work stays yours: browser, folder, or your own Drive"),
      el("li", {}, "No subscription. No trial. No limits."),
    ),
  );
}

export interface PasswordHandlers {
  onSubmit: (password: string) => void;
  onSignOut: () => void;
}

export function passwordView(
  email: string | null,
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
      "This unlocks the editor. The password is used only for this access attempt and is " +
        "never saved in this browser.",
    ),
    el(
      "button",
      { class: "btn btn-primary", type: "submit", disabled: state.busy === true },
      state.busy ? "Checking…" : "Unlock",
    ),
  );

  return shell(
    wordmark(),
    el("h1", {}, "Enter the access password"),
    el(
      "p",
      { class: "lede" },
      "LaTeXRenderer is private. Enter the access password to continue.",
    ),
    // Only after sign-in does an address exist to show; before it, this is the front door.
    email ? el("p", { class: "signed-in-as" }, `Signed in as ${email}`) : null,
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
    // Only meaningful once somebody is signed in; before that there is no account to swap.
    email
      ? el(
          "button",
          { class: "btn btn-quiet", type: "button", onclick: handlers.onSignOut },
          "Use a different account",
        )
      : el(
          "p",
          { class: "muted small" },
          "You will be asked to sign in with Google after this.",
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
