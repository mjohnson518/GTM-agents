// GTM-agents: the configuration schema behind gtm.config.ts.
//
// Everything specific to one company lives in gtm.config.ts, brain/ and templates/. This schema
// validates the config at startup so a typo fails loudly instead of silently changing behavior.
// Secrets never belong here: they come from `wrangler secret put`.
import { z } from "zod";
import { ACTION_CLASSES, isPermanentHuman } from "../autonomy/levels.ts";
import { MODEL_ROLES } from "../ports/model.ts";

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADAPTER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

const domain = z.string().regex(DOMAIN, "use a lowercase domain such as acme.example, with no scheme or path");
const httpsUrl = z.url({ protocol: /^https$/, error: "use an https:// URL" });

const address = z.strictObject({
  email: z.email(),
  name: z.string().min(1).max(80).optional(),
});

const modelPrice = z.strictObject({
  /** US cents per million input tokens. */
  inputCentsPerMTok: z.number().nonnegative(),
  /** US cents per million output tokens. */
  outputCentsPerMTok: z.number().nonnegative(),
  /** Price multiplier for cache writes, relative to input. */
  cacheWriteMultiplier: z.number().nonnegative().default(1.25),
  /** Price multiplier for cache reads, relative to input. */
  cacheReadMultiplier: z.number().nonnegative().default(0.1),
});

const sequenceStep = z.strictObject({
  step: z.number().int().min(1).max(10),
  kind: z.enum(["cold_intro", "follow_up", "breakup"]),
  /** Days after the previous step. */
  delayDays: z.number().int().min(0).max(60).default(0),
});

const moduleToggle = z.strictObject({ enabled: z.boolean().default(false) }).prefault({});

export const configSchema = z
  .strictObject({
    company: z.strictObject({
      name: z.string().min(1).max(120),
      domain,
      url: httpsUrl,
      product: z.strictObject({
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(500),
      }),
    }),
    agent: z.strictObject({
      /** The name the agent signs with and introduces itself by. */
      name: z.string().min(1).max(60),
    }),
    sending: z.strictObject({
      /** The cold sender, on the isolated sending subdomain. */
      from: address,
      /** The real mailbox replies go to. */
      replyTo: z.email(),
      supportAddress: z.email(),
      /** Appended to every cold email, with the unsubscribe line. */
      postalAddress: z.string().min(10).max(300),
      /** The isolated subdomain cold mail is sent from, for example outreach.acme.example. */
      domain,
      windowDays: z.array(z.enum(WEEKDAYS)).min(1).default(["MON", "TUE", "WED", "THU"]),
      /** Recipient-local send window, in whole hours (start inclusive, end exclusive). */
      windowHours: z
        .strictObject({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) })
        .default({ start: 8, end: 15 })
        .refine((w) => w.start < w.end, "windowHours.start must be before windowHours.end"),
      bookingUrl: httpsUrl.optional(),
    }),
    adapters: z
      .record(
        z.string().regex(ADAPTER_NAME, "adapter names are kebab-case, for example email-resend"),
        z.strictObject({
          enabled: z.boolean().default(true),
          options: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .default({}),
    models: z
      .strictObject({
        /** Model id per role. Roles without a model are unavailable. */
        roles: z.partialRecord(z.enum(MODEL_ROLES), z.string().min(1)).default({}),
        /** Price per model id, used by the cost ledger. */
        pricing: z.record(z.string().min(1), modelPrice).default({}),
      })
      .prefault({}),
    autonomy: z
      .strictObject({
        /** Starting level per action class. Only a person raises levels after that. */
        defaults: z.partialRecord(z.enum(ACTION_CLASSES), z.number().int().min(0).max(3)).default({}),
      })
      .prefault({}),
    sequences: z
      .strictObject({
        cold: z
          .strictObject({ steps: z.array(sequenceStep).min(1).max(5) })
          .default({
            steps: [
              { step: 1, kind: "cold_intro", delayDays: 0 },
              { step: 2, kind: "follow_up", delayDays: 3 },
              { step: 3, kind: "breakup", delayDays: 7 },
            ],
          }),
      })
      .prefault({}),
    modules: z
      .strictObject({
        ship: moduleToggle,
        linkIntake: moduleToggle,
        classifierTier: moduleToggle,
        codeMode: moduleToggle,
      })
      .prefault({}),
    operator: z
      .strictObject({
        /** Chat ids allowed to command the agent. Empty denies everyone. */
        allowedChatIds: z.array(z.string().min(1)).default([]),
        allowedUserIds: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    if (!config.sending.domain.endsWith(`.${config.company.domain}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["sending", "domain"],
        message: `cold mail goes from an isolated subdomain of ${config.company.domain} (for example outreach.${config.company.domain}), never the primary domain`,
      });
    }
    const fromDomain = config.sending.from.email.split("@")[1]?.toLowerCase();
    if (fromDomain !== config.sending.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["sending", "from", "email"],
        message: `the cold sender must be on the sending domain (${config.sending.domain}), so the primary domain's reputation stays protected`,
      });
    }
    for (const [actionClass, level] of Object.entries(config.autonomy.defaults)) {
      if (isPermanentHuman(actionClass) && level !== undefined && level > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["autonomy", "defaults", actionClass],
          message: `${actionClass} is permanently human-only and cannot start above level 1`,
        });
      }
    }
    const steps = config.sequences.cold.steps.map((s) => s.step);
    if (steps.some((s, i) => s !== i + 1)) {
      ctx.addIssue({ code: "custom", path: ["sequences", "cold", "steps"], message: "cold sequence steps must be numbered 1, 2, 3 in order" });
    }
  });

export type GtmConfigInput = z.input<typeof configSchema>;
export type GtmConfig = z.output<typeof configSchema>;
