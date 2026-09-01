/*
  Who is actually in this game — as opposed to who has a socket open.

  Games that split people into teams, or count heads to pick a mode, have to
  answer "how many are playing?" at one moment, write the answer into state,
  and live with it. Both obvious answers are wrong, and each one is a bug that
  has actually shipped:

    p.connected only
      A player whose socket blipped during the countdown is left out
      permanently — no team, no turn, and reconnecting changes nothing because
      the list is already written. Three Clover players reported this shape on
      1 Sep 2026: "it automatically skips their turn and we get zero points for
      that turn, as if we got all their words wrong".

    state.players only
      LOBBY GHOSTS get counted. That array never shrinks — disconnect clears
      `connected`, leaving just drops the socket — so anyone who opened the
      lobby and closed their tab is on it for the life of the room. Five open a
      Taboo lobby, two wander off, three start: the roster says five, `coop`
      comes out false, and the two who left can be the whole of team B. Team B
      never takes a turn, turnsTaken.B stays 0, and the finish condition can
      never be met. Verified on the module: forty turns in, still playing,
      {A:120, B:0}. An unfinishable room, which is worse than the bug it was
      introduced to fix.

  The thing that separates the two is TIME, and the engine already records it:
  engine/index.js sets `disconnectedAt` when a socket drops. Gone for a moment
  is still playing. Gone for minutes is not.

  Reconnecting does not clear `disconnectedAt`, which costs nothing — the
  timestamp is only consulted when `connected` is false.
*/

/*
  Long enough to cover a tunnel, a lock screen, or a wifi handover; short
  enough that somebody who shut their laptop is not still holding a slot.
  Deliberately larger than the engine's 20s host-migration delay, so a blip
  that is not yet serious enough to move the host is not serious enough to cost
  you your team either.
*/
export const BLIP_GRACE_MS = 45_000;

/**
 * Is this player part of the game right now?
 * @param {{connected?: boolean, disconnectedAt?: number}} player
 * @param {number} [now]
 */
export function inTheGame(player, now = Date.now()) {
  if (!player) return false;
  if (player.connected) return true;
  /* No timestamp and not connected means they were never really here — a row
     left over from a lobby somebody opened and abandoned. */
  return typeof player.disconnectedAt === 'number'
    && (now - player.disconnectedAt) < BLIP_GRACE_MS;
}

/** The players a roster should be built from: present, or momentarily away. */
export function playingRoster(state, now = Date.now()) {
  return (state.players || []).filter((p) => inTheGame(p, now));
}
