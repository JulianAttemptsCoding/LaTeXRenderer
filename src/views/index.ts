import { el, formatExpiry } from "../lib/dom";
import { LEGAL_NOTICE } from "../config";

function wordmark(): HTMLElement {
  return el(
    "div",
    { class: "wordmark" },
    el("span", { class: "wordmark-mark", "aria-hidden": "true" }, "A"),
    el("span", { class: "wordmark-copy" },
      el("span", { class: "wordmark-text" }, "LaTeXRenderer"),
      el("span", { class: "wordmark-tagline" }, "A private, browser-first LaTeX workspace"),
    ),
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

function themeButton(): HTMLButtonElement {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const button = el("button", { class: "shell-theme", type: "button", title: `Use ${current === "light" ? "dark" : "light"} mode`, "aria-label": `Use ${current === "light" ? "dark" : "light"} mode` }, current === "light" ? "☾" : "☀");
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    button.textContent = next === "light" ? "☾" : "☀";
    button.title = `Use ${next === "light" ? "dark" : "light"} mode`;
    button.setAttribute("aria-label", button.title);
    try { localStorage.setItem("latexrenderer.shell-theme", next); } catch { /* session-only */ }
  });
  return button;
}

function shell(...children: Slot[]): HTMLElement {
  try { document.documentElement.dataset.theme = localStorage.getItem("latexrenderer.shell-theme") === "dark" ? "dark" : "light"; } catch { document.documentElement.dataset.theme = "light"; }
  // Keep the primary form first in keyboard order. The fixed-position theme control is
  // visually top-right but follows the form semantically.
  return el("div", { class: "shell" }, el("main", { class: "card" }, ...children), themeButton(), footer());
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
  onEmailSignIn?: (email: string, password: string) => void;
  onEmailSignUp?: (email: string, password: string) => void;
  onEmailReset?: (email: string) => void;
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

  const email = handlers.onEmailSignIn ? el(
    "details", { class: "email-auth" },
    el("summary", {}, "Use email and password"),
    el("form", { onsubmit: (event: Event) => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form); handlers.onEmailSignIn?.(String(data.get("email") ?? ""), String(data.get("password") ?? "")); } },
      el("label", { class: "label", for: "account-email" }, "Email"),
      el("input", { class: "input", id: "account-email", name: "email", type: "email", autocomplete: "email", required: "", maxlength: "254" }),
      el("label", { class: "label", for: "account-password" }, "Password"),
      el("input", { class: "input", id: "account-password", name: "password", type: "password", autocomplete: "current-password", required: "", minlength: "8" }),
      el("div", { class: "row" },
        el("button", { class: "btn btn-primary", type: "submit" }, "Sign in with email"),
        el("button", { class: "btn btn-quiet", type: "button", onclick: () => { const emailInput = document.getElementById("account-email") as HTMLInputElement | null; const passwordInput = document.getElementById("account-password") as HTMLInputElement | null; handlers.onEmailSignUp?.(emailInput?.value ?? "", passwordInput?.value ?? ""); } }, "Create account"),
      ),
      el("button", { class: "link-button", type: "button", onclick: () => { const emailInput = document.getElementById("account-email") as HTMLInputElement | null; handlers.onEmailReset?.(emailInput?.value ?? ""); } }, "Forgot password?"),
    ),
  ) : null;

  return shell(
    wordmark(),
    el("div", { class: "landing-layout" },
      el("section", { class: "landing-story" },
        el("span", { class: "shell-eyebrow" }, "Free, secure, and yours"),
        el("h1", {}, "Make LaTeX free and open"),
        el(
          "p",
          { class: "lede" },
          "A complete writing and typesetting workspace with no subscription. The editor " +
            "runs in your browser, and your projects stay under your control.",
        ),
        el(
          "ul",
          { class: "feature-list" },
          el("li", {}, "Write together in real time"),
          el("li", {}, "Compile privately in your browser"),
          el("li", {}, "Use browser storage, folders, or your Drive"),
          el("li", {}, "No subscription, trial, or usage limits"),
        ),
        el("div", { class: "document-graphic", "aria-hidden": "true" },
          el("span", { class: "graphic-code" }, "\\begin{document}"),
          el("span", { class: "graphic-line" }),
          el("span", { class: "graphic-line graphic-line-short" }),
          el("span", { class: "graphic-formula" }, "∫ f(x) dx"),
        ),
      ),
      el("section", { class: "auth-panel", "aria-label": "Sign in" },
        el("div", { class: "auth-icon", "aria-hidden": "true" }, "→"),
        el("h2", {}, "Open your workspace"),
        el("p", { class: "muted small" }, "Sign in to continue to your private projects."),
        error ? el("div", { class: "alert alert-error", role: "alert" }, error) : null,
        button,
        email,
        el(
          "p",
          { class: "privacy-note" },
          "We request only your basic profile. We never receive your Google password or files.",
        ),
      ),
    ),
  );
}

export function passwordRecoveryView(onSubmit: (password: string) => void, error?: string | null): HTMLElement {
  const input = el("input", { class: "input", id: "new-password", name: "new-password", type: "password", autocomplete: "new-password", minlength: "12", required: "" });
  return shell(wordmark(), el("h1", {}, "Choose a new password"), el("p", { class: "muted" }, "Use at least 12 characters. This changes only your LaTeXRenderer account password."), error ? el("div", { class: "alert alert-error", role: "alert" }, error) : null, el("form", { onsubmit: (event: Event) => { event.preventDefault(); onSubmit((input as HTMLInputElement).value); } }, el("label", { class: "label", for: "new-password" }, "New password"), input, el("button", { class: "btn btn-primary", type: "submit" }, "Save new password")));
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
    el("div", { class: "access-visual", "aria-hidden": "true" }, el("span", {}, "A"), el("i", {})),
    el("span", { class: "shell-eyebrow" }, "Protected workspace"),
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
    el("div", { class: "access-form-panel" }, form),
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
