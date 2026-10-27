import type { Settings } from "@mb/stock-core/settings"
import type { WireCategory } from "@mb/stock-core/wire"
import type {
  Emit as EmitOf,
  Lexicon as LexiconOf,
  RawItem as RawItemOf,
  SourceContext as SourceContextOf,
  SourceSpec as SourceSpecOf,
  WireSource as WireSourceOf,
} from "@mb/wire/types"

export type { SourceKind, SymbolSets } from "@mb/wire/types"

/** The news engine's building blocks (@mb/wire/types) bound to stock's wire categories and settings. */

export type RawItem = RawItemOf<WireCategory>
export type Emit = EmitOf<WireCategory>
export type SourceContext = SourceContextOf<Settings["wire"]>
export type SourceSpec = SourceSpecOf<WireCategory, Settings["wire"]>
export type WireSource = WireSourceOf<WireCategory>
export type Lexicon = LexiconOf<WireCategory>
