/**
 * Sends a push to every registered device, pruning dead tokens as it goes.
 *
 * Usage (from backend/):
 *   node scripts/send-push.js --title "The herd has spoken" --body "See how you did" --route /daily
 *   node scripts/send-push.js --dry                       # count only, sends nothing
 *   node scripts/send-push.js --token <one-token>         # test a single device
 *
 * The daily reminder does NOT need this — that is a local notification
 * scheduled on the device. Use this for things the phone cannot know in
 * advance: results being ready, a new game launching, a streak about to lapse.
 *
 * Cron example (server time), once the Firebase env vars are set:
 *   0 9 * * *  cd /app && node scripts/send-push.js --title "Today's Herd is live" --body "..."
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { sendToToken, isConfigured } from '../src/push/fcm.js';
import { TOKENS } from '../src/push/pushRoutes.js';

dotenv.config();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const DRY = Boolean(arg('dry', false));
const ONLY_TOKEN = typeof arg('token') === 'string' ? arg('token') : null;
const TITLE = arg('title', "Today's Herd games are live");
const BODY = arg('body', 'A fresh Daily Herd is grazing. Keep your streak going.');
const ROUTE = arg('route', '/daily');

// FCM allows ~600 req/s per project; this is far below that but batching keeps
// a few thousand sends from opening a few thousand sockets at once.
const BATCH = 25;

async function main() {
  if (!isConfigured()) {
    console.error('FCM is not configured. Set FCM_PROJECT_ID, FCM_CLIENT_EMAIL and');
    console.error('FCM_PRIVATE_KEY from the Firebase service-account JSON. Nothing sent.');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality';
  await mongoose.connect(uri);
  const col = mongoose.connection.collection(TOKENS);

  const query = ONLY_TOKEN ? { token: ONLY_TOKEN } : {};
  const rows = await col.find(query, { projection: { token: 1 } }).toArray();
  console.log(`${rows.length} device token(s)`);
  console.log(`title: ${TITLE}\nbody:  ${BODY}\nroute: ${ROUTE}`);

  if (DRY) {
    console.log('\n--dry: nothing sent.');
    await mongoose.disconnect();
    return;
  }

  let sent = 0, failed = 0;
  const stale = [];

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((r) =>
        sendToToken(r.token, { title: TITLE, body: BODY, route: ROUTE })
          .then((res) => ({ token: r.token, res }))
          .catch((err) => ({ token: r.token, res: { ok: false, error: err.message } }))
      )
    );
    for (const { token, res } of results) {
      if (res.ok) sent++;
      else {
        failed++;
        if (res.stale) stale.push(token);
        else if (failed <= 3) console.warn('  send failed:', res.status, res.error);
      }
    }
    process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');

  if (stale.length) {
    await col.deleteMany({ token: { $in: stale } });
    console.log(`pruned ${stale.length} dead token(s)`);
  }
  console.log(`sent ${sent}, failed ${failed}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
