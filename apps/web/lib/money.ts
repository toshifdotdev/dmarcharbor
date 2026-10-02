/**
 * money.ts — integer minor units only. Prices live as cents (USD) and paise
 * (INR); nothing in this app may turn one into a float. Rule 6 of the brief:
 * a rounding error is a real charge.
 */

import type { PlanPriceMinor } from "./types";

export function formatMinor(
  minor: number,
  currency: "USD" | "INR",
  opts: { withSymbol?: boolean } = {},
): string {
  const symbol = currency === "USD" ? "$" : "₹";
  // Integer division and modulo — the minor unit never becomes a float.
  const major = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  const grouped = major.toLocaleString("en-US");
  const fraction = rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`;
  return `${opts.withSymbol === false ? "" : symbol}${grouped}${fraction}`;
}

export function priceLabel(
  price: PlanPriceMinor,
  currency: "USD" | "INR",
  period: "monthly" | "annual",
): string {
  const minor = period === "monthly" ? price.monthlyMinor : price.annualMinor;
  return formatMinor(minor, currency);
}

/** Two-letter currency code from the API's own enum. Never invented here. */
export function currencySymbol(currency: string): string {
  return currency === "INR" ? "₹" : "$";
}
