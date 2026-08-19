import { randomUUID } from "node:crypto";
import type { LocalApiDb } from "../db.js";
import type { ErrorCode } from "../types.js";
import { addDailyUsed, dailyRemaining, type Key } from "./keys.js";

export type ChargeFailure = "payment_required" | "daily_cap";
export type ChargeResult = { ok: true; key: Key } | { ok: false; code: ChargeFailure };

export function chargeCredits(
  db: LocalApiDb,
  input: {
    key: Key;
    route: string;
    credits: number;
    cached: boolean;
    errorCode?: ErrorCode;
  },
): Key {
  if (input.credits < 0) {
    throw new Error("credits must be >= 0");
  }
  if (input.credits === 0) {
    db.prepare(
      `INSERT INTO usage_events (id, key_id, route, credits, cached, error_code, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      `use_${randomUUID()}`,
      input.key.id,
      input.route,
      input.cached ? 1 : 0,
      input.errorCode ?? null,
      new Date().toISOString(),
    );
    return input.key;
  }
  const updated = db
    .prepare<[number, string, number], { credits: number }>(
      `UPDATE keys SET credits = credits - ?
       WHERE id = ? AND credits >= ?
       RETURNING credits`,
    )
    .get(input.credits, input.key.id, input.credits);
  if (updated === undefined) {
    return input.key;
  }
  db.prepare(
    `INSERT INTO usage_events (id, key_id, route, credits, cached, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    `use_${randomUUID()}`,
    input.key.id,
    input.route,
    input.credits,
    input.cached ? 1 : 0,
    new Date().toISOString(),
  );
  return { ...input.key, credits: updated.credits };
}

export function tryCharge(
  db: LocalApiDb,
  key: Key,
  credits: number,
  route: string,
): ChargeResult {
  if (key.credits < credits) {
    return { ok: false, code: "payment_required" };
  }
  if (credits > 0 && dailyRemaining(key) < credits) {
    return { ok: false, code: "daily_cap" };
  }
  const apply = db.transaction((): ChargeResult => {
    const next = chargeCredits(db, { key, route, credits, cached: false });
    if (next.credits === key.credits && credits > 0) {
      return { ok: false, code: "payment_required" };
    }
    if (credits === 0) {
      return { ok: true, key: next };
    }
    return { ok: true, key: addDailyUsed(db, next, credits) };
  });
  return apply();
}

export function tryChargeOrPaymentRequired(
  db: LocalApiDb,
  key: Key,
  credits: number,
  route: string,
): { ok: true; key: Key } | { ok: false } {
  if (key.credits < credits) {
    return { ok: false };
  }
  const next = chargeCredits(db, { key, route, credits, cached: false });
  if (next.credits === key.credits && credits > 0) {
    return { ok: false };
  }
  return { ok: true, key: next };
}
