// This client's own visitor id, as WorldClient persists it. Used to scope a
// directed event (a screen beat, an escort command) to ONLY the visitor it's
// addressed to — every client receives the event, but only a matching id acts
// on it. Mirrors the inline fallback DirectorBeat.tsx already uses.
export function getMyVisitorId(): string | null {
  try {
    return localStorage.getItem('town.visitorId');
  } catch {
    return null;
  }
}
