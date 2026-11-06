/**
 * Strategy catalog. Each strategy only proposes candidates from deterministic screens; the AI
 * decides whether a candidate is worth trading, and the risk engine has the final word. The
 * rationale and evaluation text is shown in the dashboard so every strategy states why it should
 * make money and how that claim is tested.
 */

export const STRATEGY_IDS = ["trend", "daily_trend", "mean_reversion", "momentum", "event_driven", "discretionary", "core"] as const
export type StrategyId = (typeof STRATEGY_IDS)[number]

/** The strategies an agent entry can follow: every one but the trend core, which trades by its own rules. */
export const AGENT_STRATEGY_IDS = ["trend", "daily_trend", "mean_reversion", "momentum", "event_driven", "discretionary"] as const satisfies readonly StrategyId[]

export type StrategyInfo = {
  id: StrategyId
  name: string
  summary: string
  rationale: string
  evaluation: string
  /** What the AI adds on top of the quant screen. */
  ai_role: string
}

export const STRATEGIES: Record<StrategyId, StrategyInfo> = {
  trend: {
    id: "trend",
    name: "Trend following",
    summary: "Buys assets in established uptrends (price above rising 1h/4h EMAs) that break out of their recent range.",
    rationale:
      "Crypto returns show time-series momentum: flows, leverage and narrative feedback make trends persist longer than a random walk implies. Trend entries with ATR stops keep losers small and let winners run.",
    evaluation:
      "Backtested against buy-and-hold BTC and a no-AI version of the same screen. Paper: win rate, payoff ratio and expectancy per trade after fees, by market regime.",
    ai_role: "Checks whether the trend has a fundamental driver or shows signs of exhaustion (crowding, a fading catalyst, upcoming supply unlocks).",
  },
  daily_trend: {
    id: "daily_trend",
    name: "Long-term trend",
    summary:
      "Holds assets in a long-term uptrend (50-day average above the 200-day, price above the 200-day) for weeks to months, bought above the 50-day or on a pullback to it.",
    rationale:
      "The same time-series momentum as the trend screen, on the timeframe where it is strongest and cheapest to harvest: few trades, so fees barely matter, and daily-ATR stops ride out the intraday noise that stops short-term trades.",
    evaluation:
      "Compared with buy-and-hold of the same assets: does stepping aside below the long-term trend cut drawdowns more than it costs in missed upside? Paper: return per trade after costs and holding time.",
    ai_role: "Checks that the long-term story still holds (adoption, flows, supply) and that a pullback is a dip, not the start of a breakdown.",
  },
  mean_reversion: {
    id: "mean_reversion",
    name: "Mean reversion",
    summary: "Buys sharp, oversold dislocations (RSI < 30 below the lower Bollinger band) in assets whose daily trend is intact.",
    rationale:
      "Liquidation cascades and forced selling overshoot fair value on short horizons. If nothing fundamental changed, prices tend to snap back part of the move.",
    evaluation:
      "Measured on forward 6-48h returns vs the no-AI screen. The key question is whether AI filtering of 'real news' selloffs improves the hit rate enough to beat costs.",
    ai_role: "Decides whether the drop is noise (liquidations, a temporary flow) or information (a hack, delisting, regulatory action). The latter is a no-trade.",
  },
  momentum: {
    id: "momentum",
    name: "Relative strength",
    summary: "Ranks the universe by volatility-adjusted 7d/30d returns and proposes the leaders when the broad market regime is not risk-off.",
    rationale: "Cross-sectional momentum: capital rotates into leading assets, and leaders keep outperforming laggards over days to weeks.",
    evaluation: "Compared with an equal-weight basket of the universe and with BTC. Tracks turnover, because rotation costs fees.",
    ai_role: "Looks for the reason behind the strength and flags correlation: five leaders that are all the same trade count as one bet.",
  },
  event_driven: {
    id: "event_driven",
    name: "Event driven",
    summary: "Reacts to abnormal price/volume shocks and catalysts found in research: listings, upgrades, ETF flows, macro releases.",
    rationale:
      "Markets take time to digest complex news. A verified catalyst that is not yet priced in can offer a short-lived edge; unverified rumors cannot.",
    evaluation: "Every event decision records the catalyst and whether it was verified; outcomes are scored by forward returns after costs.",
    ai_role: "Primary driver: researches and verifies the catalyst, judges how much is priced in, and refuses to trade unverified claims.",
  },
  discretionary: {
    id: "discretionary",
    name: "On-demand evaluation",
    summary: "Pairs the owner asks the AI to evaluate right now, outside the screens. Same research, decision and risk checks as any candidate.",
    rationale:
      "Not a strategy with an edge of its own: a way to put a specific pair in front of the research desk (a catalyst you noticed, or simply to test the pipeline). Tracked separately so it can't flatter the screened strategies.",
    evaluation: "Scored like every decision (forward returns after costs). Disable it if it doesn't earn its keep.",
    ai_role: "Everything: with no screen signal behind it, the AI has to find a reason to trade, and no_trade is the expected default.",
  },
  core: {
    id: "core",
    name: "Trend core",
    summary:
      "Rules, not the AI: while BTC is above its 50-day average, holds the strongest coins in a long-term uptrend (above a 50-day average that is above the 200-day, ranked by 30-day return per unit of daily volatility), each risking 1% of equity at a 2.5-ATR stop that trails winners.",
    rationale:
      "Time-series momentum is crypto's best-documented edge, and it pays through a few large trends: being invested in them, with losses cut at the stop and winners left to run, matters more than picking entries. Rules don't hesitate, trim winners or sit in cash.",
    evaluation: "Compared with holding BTC and an equal-weight basket of the universe over the same weeks: return, drawdown, and how much of each trend it caught after fees.",
    ai_role: "An overlay: news negative enough to veto an entry blocks it, and the agent may close a core position only when news about it woke the agent.",
  },
}
