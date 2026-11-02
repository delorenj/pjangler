/**
 * Scope declarations on a shared board.
 *
 * Several projects may bind one Plane board (the TOLT monorepo's game, forge and
 * root projects do). Each then declares, in its `.project.json`
 * `ticket_provider`, the label it takes (`scope_label`, e.g. "repo:game") and at
 * most one declares itself the board's default (`scope_default`: true) for
 * tickets whose labels match none. pjangler stores and serves them untouched;
 * the Bloodbank Plane ingress reads them to route a ticket to its project.
 */
export interface TicketScope {
  scope_label?: string;
  scope_default?: boolean;
}

/** The scope fields of a raw `ticket_provider` block; absent when not declared. */
export function ticketScope(ticket: unknown): TicketScope {
  const block = ticket !== null && typeof ticket === "object" ? (ticket as Record<string, unknown>) : {};
  const label = typeof block.scope_label === "string" ? block.scope_label.trim() : "";
  return {
    ...(label ? { scope_label: label } : {}),
    ...(block.scope_default === true ? { scope_default: true } : {}),
  };
}
