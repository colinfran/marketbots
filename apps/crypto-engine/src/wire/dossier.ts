import type { WireCategory, WireItemDoc } from "@mb/crypto-core/wire"
import { assembleDossier as assembleDossierOf, buildDossier as buildDossierOf, type Dossier as DossierOf, type DossierOptions } from "@mb/wire/dossier"
import type { Collection } from "mongodb"

export { toRow } from "@mb/wire/dossier"

/** What crypto's own feeds know about a cycle's subjects (@mb/wire/dossier). */
export type Dossier = DossierOf<WireCategory>

export const assembleDossier = (all: WireItemDoc[], o: DossierOptions): Dossier => assembleDossierOf(all, o)

export const buildDossier = (col: { wireItems: Collection<WireItemDoc> }, o: DossierOptions): Promise<Dossier> => buildDossierOf(col, o)
