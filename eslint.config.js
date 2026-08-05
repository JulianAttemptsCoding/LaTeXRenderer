import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "playwright-report/**", "test-results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      // The shell renders server-supplied strings. innerHTML would turn any of them into
      // an injection point on the one page that must stay trustworthy, so it is banned
      // outright rather than left to review.
      "no-restricted-properties": [
        "error",
        {
          object: "document",
          property: "write",
          message: "document.write is forbidden in the public shell.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: "Use textContent or the el() helper. innerHTML is forbidden in the shell.",
        },
        {
          selector: "MemberExpression[property.name='outerHTML'][parent.type='AssignmentExpression']",
          message: "Use the el() helper. outerHTML assignment is forbidden in the shell.",
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: "Dynamic code construction is forbidden in the shell.",
        },
        {
          selector: "CallExpression[callee.name='eval']",
          message: "eval is forbidden in the shell.",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.mjs", "*.config.ts", "*.config.js"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
