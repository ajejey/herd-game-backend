import mongoose from 'mongoose';
import * as store from './engine/store.js';
import { describeGame } from './engine/gameDirectory.js';

/*
  Which game does this room code belong to?

  ── Why this is its own module ──────────────────────────────────────────────

  This logic was written for the search box (findRoom.js) and lived inside an
  Express route handler, so the only way to ask the question was over HTTP.
  The socket join paths could not use it, and they are exactly where the
  question gets asked in anger — by somebody holding a code that works,
  standing on the wrong page.

  Error data for the 30 days to 13 Sep 2026:

    page "herd", 4-character code, "Game not found"   -> 35 people
    engine page, 6-character code, "Room not found"   ->  3 people

  Herd Mentality issues SIX character codes; the engine games issue FOUR. A
  four-character code typed into the Herd Mentality join box is therefore never
  a Herd Mentality code — it is a live Scattergories or Hue Match room, and
  those 35 people were told their code did not exist while their friends sat
  waiting in it.

  The engine already handled its own half of this: a code for another ENGINE
  game produces "That code is for Taboo, not this game." The legacy Herd game
  predates all of that and had no equivalent, in either direction. That is the
  gap this closes, with the lookup that was already written and already
  covering all three stores.

  ── Where a code can be ─────────────────────────────────────────────────────

  Three places, checked in this order, because they age differently:

    1. The live in-memory store. Authoritative and instant. A room made ten
       seconds ago is here and nowhere else — persistence is debounced, so
       looking only at Mongo would fail exactly for the freshest rooms, which
       are the ones people are being invited to right now.
    2. game_rooms, the snapshot. Covers a room that outlived a restart.
    3. games, the legacy Herd collection, which predates the engine and lives
       at /game/CODE rather than a namespace.

  ── What it deliberately does not say ───────────────────────────────────────

  A game name and a path. Not whether the game has started, not who is in it,
  not anything about its contents — the same answer somebody could get by
  opening each game and trying the code, just without the ten minutes.
*/

/* Codes are 4-6 of [A-Z0-9]; anything else is not worth a database round trip. */
export const CODE = /^[A-Z0-9]{4,6}$/;

const db = () => (mongoose.connection?.readyState === 1 ? mongoose.connection : null);

/**
 * @returns {Promise<null | {code, game, path, live, direct?, namespace?}>}
 *   null when the code is malformed or belongs to no room anywhere.
 *   Never throws: a lookup failure must not turn a join error into a 500.
 */
export async function lookupRoom(rawCode) {
  try {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!CODE.test(code)) return null;

    /* 1. Live rooms. state.game is the namespace, set at creation. */
    for (const [roomCode, state] of store.allGames()) {
      if (roomCode !== code) continue;
      const dest = describeGame(state?.game);
      if (dest) return { code, game: dest.name, path: dest.path, live: true, namespace: state?.game };
    }

    const conn = db();
    if (!conn) return null;

    /* 2. A room that survived a restart. */
    const snap = await conn.collection('game_rooms').findOne({ roomCode: code });
    if (snap?.namespace) {
      const dest = describeGame(snap.namespace);
      if (dest) return { code, game: dest.name, path: dest.path, live: false, namespace: snap.namespace };
    }

    /*
      3. The original Herd game. It has no namespace because it predates the
         engine, and its room lives at /game/CODE rather than /<game>/room/CODE
         — so the path is built differently on purpose, not by oversight.
    */
    const legacy = await conn.collection('games').findOne({ roomCode: code });
    if (legacy) {
      return { code, game: 'Herd Mentality', path: `/game/${code}`, live: false, direct: true, namespace: null };
    }

    return null;
  } catch (err) {
    console.error('lookupRoom failed:', err?.message || err);
    return null;
  }
}

/**
 * The message shown to somebody whose code is real but belongs elsewhere.
 * Deliberately names the game and says the code still works, because the
 * person is one tap from playing and does not need to be told to check it.
 */
export function elsewhereMessage(found) {
  if (!found) return null;
  return `That code is for ${found.game}. Open ${found.game} and join with the same code.`;
}
