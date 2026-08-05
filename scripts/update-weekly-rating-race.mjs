import fs from 'node:fs/promises';

const CLUB_SLUG = 'blundering-buddies';
const STATE_FILE = 'data/weekly-rating-state.json';
const OUTPUT_FILE = 'weekly-rating-race.json';

const FALLBACK_AVATAR =
  'https://www.chess.com/bundles/web/images/user-image.007dad08.svg';

const API_CONTACT =
  process.env.CHESS_API_CONTACT ||
  'https://www.chess.com/club/blundering-buddies';

const USER_AGENT = `Blundering Buddies weekly rating race (${API_CONTACT})`;

const CONCURRENCY = 5;
const RETRIES = 4;
const RETRY_DELAY_MS = 1500;
const MIN_ACCOUNT_AGE_DAYS = 90;
const MIN_GAMES_PER_FORMAT = 100;
const TOP_COUNT = 3;

const FORMATS = [
  { name: 'rapid', apiKey: 'chess_rapid' },
  { name: 'blitz', apiKey: 'chess_blitz' },
  { name: 'bullet', apiKey: 'chess_bullet' }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function getUtcWeekWindow(now = new Date()) {
  const startMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - now.getUTCDay(),
    0,
    0,
    0,
    0
  );

  const endMs = startMs + 7 * 24 * 60 * 60 * 1000;

  return {
    weekKey: iso(startMs).slice(0, 10),
    weekStartedAt: iso(startMs),
    weekEndsAt: iso(endMs)
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fetchJson(url, { allow404 = false } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        }
      });

      if (allow404 && response.status === 404) return null;

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${url}`);
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      const retryable =
        !error?.status || error.status === 429 || error.status >= 500;

      if (!retryable || attempt === RETRIES) break;

      const jitter = Math.floor(Math.random() * 500);
      await sleep(RETRY_DELAY_MS * attempt + jitter);
    }
  }

  throw lastError;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner())
  );

  return results;
}

function uniqueClubMembers(data) {
  const all = [
    ...(data?.weekly || []),
    ...(data?.monthly || []),
    ...(data?.all_time || [])
  ];

  const members = new Map();

  for (const member of all) {
    const username = String(member?.username || '').trim();
    if (!username) continue;

    const key = username.toLowerCase();
    if (!members.has(key)) members.set(key, username);
  }

  return Array.from(members, ([key, username]) => ({ key, username }));
}

function totalGames(formatStats) {
  const record = formatStats?.record || {};

  return ['win', 'loss', 'draw'].reduce((total, key) => {
    const value = Number(record[key] || 0);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function currentRating(formatStats) {
  const rating = Number(formatStats?.last?.rating);
  return Number.isFinite(rating) ? rating : null;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

const now = new Date();
const updatedAt = now.toISOString();
const week = getUtcWeekWindow(now);
const emptyState = {
  weekKey: week.weekKey,
  weekStartedAt: week.weekStartedAt,
  weekEndsAt: week.weekEndsAt,
  members: {}
};

let state = await readJson(STATE_FILE, emptyState);
const isNewWeek = state.weekKey !== week.weekKey;

if (isNewWeek) {
  state = { ...emptyState };
  console.log(`Starting a new weekly race: ${week.weekKey}`);
}

const clubData = await fetchJson(
  `https://api.chess.com/pub/club/${CLUB_SLUG}/members`
);

const clubMembers = uniqueClubMembers(clubData);
const currentMemberKeys = new Set(clubMembers.map(member => member.key));
const accountAgeCutoffMs =
  now.getTime() - MIN_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000;

console.log(`Found ${clubMembers.length} unique club members.`);

let successfulChecks = 0;
let failedChecks = 0;

await mapLimit(clubMembers, CONCURRENCY, async ({ key, username }, index) => {
  const previous = state.members[key] || null;

  try {
    let profile = null;

    if (!previous?.createdAt) {
      profile = await fetchJson(
        `https://api.chess.com/pub/player/${encodeURIComponent(username)}`,
        { allow404: true }
      );
    }

    const joinedSeconds = Number(profile?.joined);
    const createdAt = previous?.createdAt ||
      (Number.isFinite(joinedSeconds) ? new Date(joinedSeconds * 1000).toISOString() : null);

    if (!createdAt) {
      failedChecks += 1;
      return;
    }

    const createdAtMs = Date.parse(createdAt);
    const accountOldEnough =
      Number.isFinite(createdAtMs) && createdAtMs <= accountAgeCutoffMs;

    const status = String(profile?.status || previous?.status || '').toLowerCase();

    if (!accountOldEnough || status === 'closed') {
      delete state.members[key];
      successfulChecks += 1;
      return;
    }

    const stats = await fetchJson(
      `https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`,
      { allow404: true }
    );

    if (!stats) {
      failedChecks += 1;
      return;
    }

    const memberState = previous || {
      username,
      avatar: profile?.avatar || FALLBACK_AVATAR,
      profileUrl: `https://www.chess.com/member/${encodeURIComponent(username)}`,
      createdAt,
      status: profile?.status || null,
      formats: {}
    };

    memberState.username = profile?.username || memberState.username || username;
    memberState.avatar = profile?.avatar || memberState.avatar || FALLBACK_AVATAR;
    memberState.profileUrl =
      profile?.url ||
      memberState.profileUrl ||
      `https://www.chess.com/member/${encodeURIComponent(username)}`;
    memberState.createdAt = createdAt;
    memberState.status = profile?.status || memberState.status || null;
    memberState.lastCheckedAt = updatedAt;
    memberState.formats ||= {};

    let hasEligibleFormat = false;

    for (const format of FORMATS) {
      const block = stats?.[format.apiKey];
      const games = totalGames(block);
      const rating = currentRating(block);

      const savedFormat = memberState.formats[format.name];

      if (games < MIN_GAMES_PER_FORMAT || rating === null) {
        if (!savedFormat) delete memberState.formats[format.name];
        if (savedFormat) hasEligibleFormat = true;
        continue;
      }

      hasEligibleFormat = true;

      const startRating = Number.isFinite(Number(savedFormat?.startRating))
        ? Number(savedFormat.startRating)
        : rating;

      memberState.formats[format.name] = {
        startRating,
        currentRating: rating,
        change: rating - startRating,
        games
      };
    }

    if (hasEligibleFormat) {
      state.members[key] = memberState;
    } else {
      delete state.members[key];
    }

    successfulChecks += 1;

    if ((index + 1) % 250 === 0) {
      console.log(`Checked ${index + 1}/${clubMembers.length} members...`);
    }
  } catch (error) {
    failedChecks += 1;
    console.warn(`Could not update ${username}: ${error?.message || error}`);
  }
});

for (const key of Object.keys(state.members)) {
  if (!currentMemberKeys.has(key)) delete state.members[key];
}

state.weekKey = week.weekKey;
state.weekStartedAt = week.weekStartedAt;
state.weekEndsAt = week.weekEndsAt;
state.updatedAt = updatedAt;

const rankedPlayers = Object.values(state.members)
  .map(member => {
    const rapid = member.formats?.rapid || null;
    const blitz = member.formats?.blitz || null;
    const bullet = member.formats?.bullet || null;

    const totalChange = [rapid, blitz, bullet].reduce(
      (total, format) => total + Number(format?.change || 0),
      0
    );

    return {
      username: member.username,
      avatar: member.avatar || FALLBACK_AVATAR,
      profileUrl: member.profileUrl,
      totalChange,
      rapidChange: rapid?.change ?? null,
      blitzChange: blitz?.change ?? null,
      bulletChange: bullet?.change ?? null,
      rapidStartRating: rapid?.startRating ?? null,
      blitzStartRating: blitz?.startRating ?? null,
      bulletStartRating: bullet?.startRating ?? null,
      rapidCurrentRating: rapid?.currentRating ?? null,
      blitzCurrentRating: blitz?.currentRating ?? null,
      bulletCurrentRating: bullet?.currentRating ?? null
    };
  })
  .sort((a, b) => {
    if (b.totalChange !== a.totalChange) return b.totalChange - a.totalChange;
    return a.username.localeCompare(b.username);
  });

const eligibleMembers = Object.keys(state.members).length;

const output = {
  status: isNewWeek ? 'baseline-created' : 'ready',
  updatedAt,
  weekStartedAt: week.weekStartedAt,
  weekEndsAt: week.weekEndsAt,
  resetRule: 'Every Sunday at 00:00 UTC',
  minimumAccountAgeDays: MIN_ACCOUNT_AGE_DAYS,
  minimumGamesPerCountedFormat: MIN_GAMES_PER_FORMAT,
  checkedMembers: successfulChecks,
  failedMembers: failedChecks,
  eligibleMembers,
  players: isNewWeek ? [] : rankedPlayers.slice(0, TOP_COUNT)
};

await writeJson(STATE_FILE, state);
await writeJson(OUTPUT_FILE, output);

console.log(`Updated ${OUTPUT_FILE}.`);
console.log(`Successful checks: ${successfulChecks}`);
console.log(`Failed checks: ${failedChecks}`);
console.log(`Eligible members: ${eligibleMembers}`);

for (const [index, player] of output.players.entries()) {
  console.log(
    `${index + 1}. ${player.username}: ${signed(player.totalChange)} ` +
      `(Rapid ${player.rapidChange ?? 'N/A'}, Blitz ${player.blitzChange ?? 'N/A'}, ` +
      `Bullet ${player.bulletChange ?? 'N/A'})`
  );
}
