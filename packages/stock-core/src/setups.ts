import { SETUPS } from "./report"

/**
 * What each trade setup means, shown on the dashboard's strategies page. Grok labels every decision
 * with one setup (report.ts); nothing here screens or trades automatically. The text states what the
 * setup is, why it should make money, and what the AI is there to judge, so each claim can be checked
 * against its results.
 */

export type Setup = (typeof SETUPS)[number]

export type SetupInfo = {
  id: Setup
  name: string
  summary: string
  rationale: string
  /** What the AI is there to judge before taking the trade. */
  ai_role: string
}

export const SETUP_INFO: Record<Setup, SetupInfo> = {
  momentum: {
    id: "momentum",
    name: "Momentum",
    summary: "Rides a stock that is already moving with the market behind it: above VWAP, a rising trend and relative strength against SPY.",
    rationale: "Moves fed by real flows and news tend to persist for longer than a random walk implies. Buying strength with a stop under the trend keeps losers small and lets winners run.",
    ai_role: "Checks the move has a reason (news, earnings, sector rotation) and isn't a late, exhausted spike.",
  },
  breakout: {
    id: "breakout",
    name: "Breakout",
    summary: "Buys a clean break above a defined level (the opening range, the prior day's high, a 20-day high) on rising volume.",
    rationale: "When a level where sellers sat gives way on volume, new buyers and trapped shorts can push price quickly. The stop sits just under the broken level, so the risk is defined.",
    ai_role: "Confirms the level matters and the volume is real, and avoids breaking straight into resistance or a scheduled event.",
  },
  pullback: {
    id: "pullback",
    name: "Pullback",
    summary: "Buys a dip to support (VWAP, a rising 20-day average, a prior breakout level) inside an established uptrend.",
    rationale: "Joining a trend on a retracement gives a better price and a tighter stop than chasing the high.",
    ai_role: "Judges whether the dip is profit-taking in a healthy trend or the start of a reversal.",
  },
  vwap_reclaim: {
    id: "vwap_reclaim",
    name: "VWAP reclaim",
    summary: "Buys a stock that lost VWAP and then reclaims and holds above it.",
    rationale: "VWAP is the average price institutions measure their fills against. Reclaiming it shows buyers back in control, with an obvious level to put the stop under.",
    ai_role: "Checks the reclaim holds with SPY and QQQ supportive, rather than chop around the line.",
  },
  mean_reversion: {
    id: "mean_reversion",
    name: "Mean reversion",
    summary: "Buys a sharp, stretched drop (far below VWAP or the 20-day average, oversold RSI) when nothing fundamental changed.",
    rationale: "Forced selling and overreaction overshoot fair value on short horizons. With no new information, prices tend to retrace part of the move.",
    ai_role: "Separates noise from information: a downgrade, a guidance cut or a fraud allegation makes it a no-trade.",
  },
  catalyst: {
    id: "catalyst",
    name: "Catalyst",
    summary: "Trades a specific, verified event: earnings, guidance, an upgrade, a regulatory decision, a contract or a macro release.",
    rationale: "Markets take time to digest complex news. A verified catalyst that isn't priced in yet can offer a short-lived edge; an unverified rumor cannot.",
    ai_role: "Primary driver: finds and verifies the catalyst with web and X search, and judges how much of it is already in the price.",
  },
  gap_and_go: {
    id: "gap_and_go",
    name: "Gap and go",
    summary: "Buys a stock that gapped up on news and holds above its premarket and opening-range highs after the open.",
    rationale: "A gap on real news draws attention and volume all day, and the strongest gaps keep going after the first range.",
    ai_role: "Checks what caused the gap and whether it is holding or fading. A gap on thin news or into old resistance is skipped.",
  },
  hedge: {
    id: "hedge",
    name: "Hedge",
    summary: "A position that gains when the market falls, such as an inverse ETF or a put, sized against the risk already in the book.",
    rationale: "Not a profit engine on its own: it cuts the downside when the tape turns, to protect a green day.",
    ai_role: "Decides when the tape is weak enough to be worth paying for protection.",
  },
  other: {
    id: "other",
    name: "Other",
    summary: "Ideas that don't fit a named setup. Same risk checks as everything else.",
    rationale: "A catch-all so every trade is labeled. It is tracked separately so it can't flatter the named setups.",
    ai_role: "Has to make the case for the edge itself, in the decision's rationale.",
  },
}
