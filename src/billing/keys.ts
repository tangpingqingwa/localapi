import { createHash, randomUUID } from "node:crypto";
import type { LocalApiDb } from "../db.js";
import type { KeyPrefix, Plan } from "../types.js";

export type Key = {
  id: string;
  prefix: KeyPrefix;
  plan: Plan;
  credits: number;
  rpm: number;
  dailyUsed: number;
  dailyReset: string;
  createdAt: string;
};

export const DEFAULT_FREE_CREDITS = 100;
export const DEFAULT_FREE_RPM = 30;
export const DEFAULT_FREE_DAILY_CAP = 50;
export const DEFAULT_PAID_DAILY_CAP = 500;

type KeyRow = {
  id: string;
  prefix: KeyPrefix;
  plan: string;
  credits: number;
  rpm: number;
  daily_used: number;
  daily_reset: string;
  created_at: string;
};

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function prefixFromSecret(secret: string): KeyPrefix | null {
  if (secret.startsWith("lk_test_") && secret.length > "lk_test_".length) {
    return "lk_test";
  }
  if (secret.startsWith("lk_live_") && secret.length > "lk_live_".length) {
    return "lk_live";
  }
  return null;
}

export function utcCalendarDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isPaidPlan(plan: string): plan is Extract<Plan, "monthly" | "annual"> {
  return plan === "monthly" || plan === "annual";
}

export function parsePlan(plan: string): Plan {
  if (plan === "free" || plan === "monthly" || plan === "annual") {
    return plan;
  }
  throw new Error(`Unknown plan in database: ${plan}`);
}

export function dailyCapForPlan(plan: string): number {
  return isPaidPlan(plan) ? DEFAULT_PAID_DAILY_CAP : DEFAULT_FREE_DAILY_CAP;
}

export function dailyRemaining(key: Pick<Key, "plan" | "dailyUsed">): number {
  return Math.max(0, dailyCapForPlan(key.plan) - key.dailyUsed);
}

export function createKey(
  db: LocalApiDb,
  input: {
    secret: string;
    plan?: Plan;
    credits?: number;
    rpm?: number;
    dailyUsed?: number;
    dailyReset?: string;
    id?: string;
    now?: Date;
  },
): Key {
  const prefix = prefixFromSecret(input.secret);
  if (prefix === null) {
    throw new Error("API key must start with lk_live_ or lk_test_");
  }
  const now = input.now ?? new Date();
  const key: Key = {
    id: input.id ?? `key_${randomUUID()}`,
    prefix,
    plan: input.plan ?? "free",
    credits: input.credits ?? DEFAULT_FREE_CREDITS,
    rpm: input.rpm ?? DEFAULT_FREE_RPM,
    dailyUsed: input.dailyUsed ?? 0,
    dailyReset: input.dailyReset ?? utcCalendarDay(now),
    createdAt: now.toISOString(),
  };
  db.prepare(
    `INSERT INTO keys (id, prefix, hash, plan, credits, rpm, daily_used, daily_reset, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key.id,
    key.prefix,
    hashSecret(input.secret),
    key.plan,
    key.credits,
    key.rpm,
    key.dailyUsed,
    key.dailyReset,
    key.createdAt,
  );
  return key;
}

function rowToKey(row: KeyRow): Key {
  return {
    id: row.id,
    prefix: row.prefix,
    plan: parsePlan(row.plan),
    credits: row.credits,
    rpm: row.rpm,
    dailyUsed: row.daily_used,
    dailyReset: row.daily_reset,
    createdAt: row.created_at,
  };
}

export function refreshDailyWindow(db: LocalApiDb, key: Key, now: Date = new Date()): Key {
  const today = utcCalendarDay(now);
  if (key.dailyReset === today) {
    return key;
  }
  db.prepare("UPDATE keys SET daily_used = 0, daily_reset = ? WHERE id = ?").run(
    today,
    key.id,
  );
  return { ...key, dailyUsed: 0, dailyReset: today };
}

export function lookupKey(
  db: LocalApiDb,
  secret: string,
  now: Date = new Date(),
): Key | null {
  if (prefixFromSecret(secret) === null) {
    return null;
  }
  const row = db
    .prepare<[string], KeyRow>(
      `SELECT id, prefix, plan, credits, rpm, daily_used, daily_reset, created_at
       FROM keys WHERE hash = ?`,
    )
    .get(hashSecret(secret));
  if (row === undefined) {
    return null;
  }
  return refreshDailyWindow(db, rowToKey(row), now);
}

export function addDailyUsed(
  db: LocalApiDb,
  key: Key,
  amount: number,
  now: Date = new Date(),
): Key {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("daily increment must be a non-negative integer");
  }
  const current = refreshDailyWindow(db, key, now);
  if (amount === 0) {
    return current;
  }
  const nextUsed = current.dailyUsed + amount;
  db.prepare("UPDATE keys SET daily_used = ? WHERE id = ?").run(nextUsed, current.id);
  return { ...current, dailyUsed: nextUsed };
}

export function bootstrapKeyIfEmpty(db: LocalApiDb, secret: string): Key | null {
  const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM keys").get();
  if (count === undefined) {
    throw new Error("failed to count API keys");
  }
  if (count.n > 0) {
    return lookupKey(db, secret);
  }
  return createKey(db, { secret });
}
