// GTM-agents: ESLint configuration (flat config).
//
// Two boundaries are enforced here as well as in review:
//   - packages/core never imports a vendor SDK; third parties are reached through adapters.
//   - packages/sdk has no Cloudflare dependency, so any host application can install it.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const VENDOR_SDKS = [
  "@anthropic-ai/*",
  "openai",
  "ai",
  "@ai-sdk/*",
  "resend",
  "stripe",
  "googleapis",
  "@google/*",
  "@google-cloud/*",
  "exa-js",
  "grammy",
  "telegraf",
  "node-telegram-bot-api",
  "@slack/*",
  "@aws-sdk/*",
  "@sendgrid/*",
  "postmark",
  "mailgun.js",
  "twilio",
];

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "apps/worker/public/**",
      ".local/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Test doubles often implement async interfaces without awaiting anything.
    files: ["**/test/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: VENDOR_SDKS,
              message: "packages/core never imports a vendor SDK. Put the integration in an adapter behind a port.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/sdk/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["cloudflare:*", "@cloudflare/*"],
              message: "packages/sdk runs in any host application and must not depend on Cloudflare.",
            },
          ],
        },
      ],
    },
  },
);
