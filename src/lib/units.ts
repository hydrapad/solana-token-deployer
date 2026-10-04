/** Supply maths, kept separate from the UI so it can be unit tested. */

/** SPL tokens store amounts as unsigned 64-bit integers. */
export const U64_MAX = 18446744073709551615n;

/**
 * Scale a human-entered amount into SPL base units without floating point.
 *
 * Returns null for anything that is not a plain positive decimal number that
 * fits within `decimals` places.
 */
export function toBaseUnits(amount: string, decimals: number): bigint | null {
  const raw = amount.trim();
  if (!raw || !/^\d*\.?\d*$/.test(raw)) return null;

  const [whole = "", frac = ""] = raw.split(".");
  if (frac.length > decimals) return null;

  const padded = frac.padEnd(decimals, "0");
  try {
    const value = BigInt(whole || "0") * 10n ** BigInt(decimals) + (padded ? BigInt(padded) : 0n);
    return value > 0n && value <= U64_MAX ? value : null;
  } catch {
    return null;
  }
}

/** Render base units the way a human reads them: 1.5, not 1500000000. */
export function formatAmount(amount: bigint, decimals: number): string {
  const whole = amount / 10n ** BigInt(decimals);
  const frac = amount % 10n ** BigInt(decimals);
  if (decimals === 0 || frac === 0n) return whole.toLocaleString();
  return `${whole.toLocaleString()}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export type SupplyProblem = "empty" | "format" | "precision" | "zero" | "overflow";

export type SupplyResult =
  | { ok: true; baseUnits: bigint }
  | { ok: false; problem: SupplyProblem };

/**
 * Same maths as toBaseUnits, but reports *why* an amount was rejected so the
 * form can show a useful message instead of a generic one.
 */
export function parseSupply(amount: string, decimals: number): SupplyResult {
  const raw = amount.trim();
  if (!raw) return { ok: false, problem: "empty" };
  if (!/^\d*\.?\d*$/.test(raw)) return { ok: false, problem: "format" };

  const [whole = "", frac = ""] = raw.split(".");
  if (frac.length > decimals) return { ok: false, problem: "precision" };

  const padded = frac.padEnd(decimals, "0");
  let value: bigint;
  try {
    value = BigInt(whole || "0") * 10n ** BigInt(decimals) + (padded ? BigInt(padded) : 0n);
  } catch {
    return { ok: false, problem: "format" };
  }

  if (value === 0n) return { ok: false, problem: "zero" };
  if (value > U64_MAX) return { ok: false, problem: "overflow" };
  return { ok: true, baseUnits: value };
}

export function describeSupplyProblem(problem: SupplyProblem): string {
  switch (problem) {
    case "empty":
      return "Enter how many tokens to create.";
    case "format":
      return "Use digits only, for example 1000000. Scientific notation is not accepted.";
    case "precision":
      return "More decimal places than the token supports.";
    case "zero":
      return "Enter a supply greater than zero.";
    case "overflow":
      return "That supply is larger than SPL tokens allow (the maximum is 18,446,744,073,709,551,615 base units).";
  }
}