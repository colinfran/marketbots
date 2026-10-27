/** Exact match against OWNER_EMAIL, ignoring case and surrounding spaces. */
export const isOwnerEmail = (email: string | null | undefined, owner: string): boolean =>
  !!email && !!owner.trim() && email.trim().toLowerCase() === owner.trim().toLowerCase()
