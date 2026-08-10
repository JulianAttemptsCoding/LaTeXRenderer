import { describe, expect, it, vi } from "vitest";
import { landingView, passwordRecoveryView } from "../../src/views";

describe("account views", () => {
  it("offers email sign-in only when handlers are configured", () => {
    const signIn = vi.fn();
    const view = landingView({ onSignIn: vi.fn(), onEmailSignIn: signIn, onEmailSignUp: vi.fn(), onEmailReset: vi.fn() });
    document.body.replaceChildren(view);
    const email = document.querySelector<HTMLInputElement>("#account-email")!;
    const password = document.querySelector<HTMLInputElement>("#account-password")!;
    email.value = "person@example.com"; password.value = "long-password";
    document.querySelector<HTMLFormElement>(".email-auth form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(signIn).toHaveBeenCalledWith("person@example.com", "long-password");
  });

  it("submits a replacement password through the recovery view", () => {
    const update = vi.fn();
    document.body.replaceChildren(passwordRecoveryView(update));
    const input = document.querySelector<HTMLInputElement>("#new-password")!;
    input.value = "a-secure-new-password";
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(update).toHaveBeenCalledWith("a-secure-new-password");
  });
});
