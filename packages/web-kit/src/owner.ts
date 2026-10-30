/** Exact match against OWNER_EMAIL, ignoring case and surrounding spaces. Without OWNER_EMAIL nobody matches. */
export const isOwnerEmail = (email: string | null | undefined, owner: string | null | undefined): boolean =>
  !!email && !!owner?.trim() && email.trim().toLowerCase() === owner.trim().toLowerCase()
