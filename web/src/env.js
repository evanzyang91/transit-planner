import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    SUPABASE_URL: z.string().url(),
    SUPABASE_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    // Which AI backend to use. Defaults to "anthropic" if unset.
    AI_PROVIDER: z.enum(["anthropic", "gemini"]).optional(),
    ELEVENLABS_KEY: z.string().min(1),
    DISCORD_WEBHOOK_URL: z.string().url().optional(),
    DISCORD_REGULAR_VISITS_WEBHOOK_URL: z.string().url().optional(),
    DISCORD_REFERRAL_VISITS_WEBHOOK_URL: z.string().url().optional(),
    DISCORD_BUG_REPORTS_WEBHOOK_URL: z.string().url().optional(),
    // Langfuse LLM tracing. All optional: with no keys the tracer is a no-op,
    // so a fresh clone builds and runs without a Langfuse account.
    LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
    LANGFUSE_BASE_URL: z.string().url().optional(),
    // Traces always flow in production; this opts local dev in too.
    LANGFUSE_TRACING_DEV: z.enum(["true", "false"]).optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    NEXT_PUBLIC_MAPBOX_TOKEN: z.string().min(1),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AI_PROVIDER: process.env.AI_PROVIDER,
    ELEVENLABS_KEY: process.env.ELEVENLABS_KEY,
    NODE_ENV: process.env.NODE_ENV,

    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    DISCORD_REGULAR_VISITS_WEBHOOK_URL:
      process.env.DISCORD_REGULAR_VISITS_WEBHOOK_URL,
    DISCORD_REFERRAL_VISITS_WEBHOOK_URL:
      process.env.DISCORD_REFERRAL_VISITS_WEBHOOK_URL,
    DISCORD_BUG_REPORTS_WEBHOOK_URL:
      process.env.DISCORD_BUG_REPORTS_WEBHOOK_URL,
    LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
    LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
    LANGFUSE_TRACING_DEV: process.env.LANGFUSE_TRACING_DEV,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: true,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
