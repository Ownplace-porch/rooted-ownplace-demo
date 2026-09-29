export function originLabel(
  origin: string | undefined,
  backend: string,
  contacts: { id: string; displayName: string }[],
  // M15 #100: a column names its owner instead of "Your porch".
  owner?: string,
): string | null {
  if (!origin) return null;
  if (origin === backend) return owner ? `${owner}'s porch` : "Your porch";
  const contact = contacts.find((c) => c.id === origin);
  if (contact && contact.displayName.trim()) return `From ${contact.displayName.trim()}`;
  return `From ${origin}`;
}

// M15 #101: who wrote an entry, named the same way as its origin label.
export function authorName(
  origin: string | undefined,
  backend: string,
  contacts: { id: string; displayName: string }[],
  owner: string,
): string {
  if (!origin || origin === backend) return owner;
  const contact = contacts.find((c) => c.id === origin);
  return contact && contact.displayName.trim() ? contact.displayName.trim() : origin;
}

export function wallLabel(author: string, owner: string): string {
  return `${author} → ${owner}'s wall`;
}
