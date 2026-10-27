/** Compounds daily % changes into one % return; null without any. */
export const compound = (pcts: number[]) => (pcts.length ? (pcts.reduce((acc, p) => acc * (1 + p / 100), 1) - 1) * 100 : null)
