// Helpers every tool module uses.

import { asArray, num, pack, iso, round, minutesBetween, type TrendWindow } from "../frm/client.ts";

export const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Run a tool body; an exception becomes an isError text result rather than a protocol error. */
export async function guard<T>(fn: () => Promise<T>): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const out = await fn();
    return text(typeof out === "string" ? out : pack(out));
  } catch (e: any) {
    return { ...text(`Error: ${e?.message ?? String(e)}`), isError: true };
  }
}

export const inv = (items: unknown) => asArray(items).map((i: any) => ({ name: i.Name, amount: num(i.Amount ?? i.amount) }));

/** How much of the KV ring a trend window actually used, and why it stopped early. */
export const history = (w: TrendWindow, now: number) => ({
  samplesUsed: w.samples.length,
  spanMinutes: w.samples.length ? round(minutesBetween(w.samples[0].t, now)) : 0,
  oldestUsable: w.samples.length ? iso(w.samples[0].t) : null,
  truncatedBy: w.truncatedBy,
  truncatedAt: w.truncatedAt ? iso(w.truncatedAt) : null,
});

