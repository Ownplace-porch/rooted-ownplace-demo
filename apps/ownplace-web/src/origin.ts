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
