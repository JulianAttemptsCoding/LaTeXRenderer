import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("the password-first gate has no serious accessibility violations", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /enter the access password/i })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(violations).toEqual([]);
});
