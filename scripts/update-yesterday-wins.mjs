import fs from 'node:fs/promises';

const CLUB_SLUG = 'blundering-buddies';
const OUTPUT_FILE = 'top-wins-yesterday.json';
const FALLBACK_AVATAR = 'https://www.chess.com/bundles/web/images/user-image.007dad08.svg';
const USER_AGENT = 'rooketamine.github.io yesterday wins counter';
const CONCURRENCY = 8;
const RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const FORMATS = new Set(['rapid', 'blitz', 'bullet']);

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function utcDateKey(date){
  return date.toISOString().slice(0, 10);
}

function getYesterdayWindowUTC(){
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = todayStart - 24 * 60 * 60 * 1000;
  const endMs = todayStart;
  const start = new Date(startMs);

  return {
    date: utcDateKey(start),
    startMs,
    endMs,
    year: String(start.getUTCFullYear()),
    month: String(start.getUTCMonth() + 1).padStart(2, '0')
  };
}

async function fetchJSON(url, { allow404 = false } = {}){
  let lastError;

  for(let attempt = 1; attempt <= RETRIES; attempt++){
    try{
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': USER_AGENT
        }
      });

      if(allow404 && res.status === 404) return null;

      if(!res.ok){
        const error = new Error(`HTTP ${res.status} for ${url}`);
        error.status = res.status;
        throw error;
      }

      return await res.json();
    }catch(err){
      lastError = err;
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if(!retryable || attempt === RETRIES) break;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

async function mapLimit(items, limit, worker){
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner(){
    while(nextIndex < items.length){
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
}

function uniqueMembers(memberData){
  const combined = [
    ...(memberData.weekly || []),
    ...(memberData.monthly || []),
    ...(memberData.all_time || [])
  ];

  const seen = new Set();
  const users = [];

  for(const member of combined){
    const username = String(member.username || '').trim();
    const key = username.toLowerCase();

    if(!username || seen.has(key)) continue;

    seen.add(key);
    users.push(username);
  }

  return users;
}

function isWinForUser(game, usernameLower){
  const whiteName = String(game?.white?.username || '').toLowerCase();
  const blackName = String(game?.black?.username || '').toLowerCase();

  if(whiteName === usernameLower) return game?.white?.result === 'win';
  if(blackName === usernameLower) return game?.black?.result === 'win';

  return false;
}

function countWinsFromGames(games, username, window){
  const usernameLower = username.toLowerCase();
  let wins = 0;

  const byFormat = {
    rapid: 0,
    blitz: 0,
    bullet: 0
  };

  for(const game of games || []){
    const endTimeMs = Number(game.end_time || 0) * 1000;

    if(endTimeMs < window.startMs || endTimeMs >= window.endMs) continue;

    const format = String(game.time_class || '').toLowerCase();

    if(!FORMATS.has(format)) continue;

    if(isWinForUser(game, usernameLower)){
      wins++;
      byFormat[format]++;
    }
  }

  return {
    username,
    wins,
    byFormat
  };
}

async function countUser(username, window){
  const archiveUrl = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${window.year}/${window.month}`;

  try{
    const archive = await fetchJSON(archiveUrl, { allow404: true });

    if(!archive){
      return {
        username,
        wins: 0,
        byFormat: {
          rapid: 0,
          blitz: 0,
          bullet: 0
        }
      };
    }

    return countWinsFromGames(archive.games || [], username, window);
  }catch(err){
    console.warn(`Could not count ${username}: ${err.message}`);

    return {
      username,
      wins: 0,
      byFormat: {
        rapid: 0,
        blitz: 0,
        bullet: 0
      },
      error: true
    };
  }
}

async function getAvatar(username){
  try{
    const profile = await fetchJSON(`https://api.chess.com/pub/player/${encodeURIComponent(username)}`, { allow404: true });
    return profile?.avatar || FALLBACK_AVATAR;
  }catch{
    return FALLBACK_AVATAR;
  }
}

async function main(){
  const window = getYesterdayWindowUTC();

  console.log(`Counting ${CLUB_SLUG} wins for ${window.date} UTC...`);

  const clubMembers = await fetchJSON(`https://api.chess.com/pub/club/${CLUB_SLUG}/members`);
  const usernames = uniqueMembers(clubMembers);

  console.log(`Found ${usernames.length} unique members.`);

  let processed = 0;

  const counted = await mapLimit(usernames, CONCURRENCY, async username => {
    const result = await countUser(username, window);
    processed++;

    if(processed % 100 === 0 || processed === usernames.length){
      console.log(`Checked ${processed}/${usernames.length} members...`);
    }

    return result;
  });

  const leaders = counted
    .filter(p => p.wins > 0)
    .sort((a, b) => b.wins - a.wins || a.username.localeCompare(b.username))
    .slice(0, 3);

  const players = await Promise.all(leaders.map(async player => ({
    username: player.username,
    wins: player.wins,
    avatar: await getAvatar(player.username),
    rapid_wins: player.byFormat.rapid,
    blitz_wins: player.byFormat.blitz,
    bullet_wins: player.byFormat.bullet
  })));

  const output = {
    ready: true,
    status: 'ready',
    club: CLUB_SLUG,
    date: window.date,
    generated_at: new Date().toISOString(),
    total_members_checked: usernames.length,
    players
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`Saved ${OUTPUT_FILE}`);
  console.log(JSON.stringify(players, null, 2));
}

main().catch(async err => {
  console.error(err);

  const window = getYesterdayWindowUTC();

  const fallback = {
    ready: false,
    status: 'counting',
    club: CLUB_SLUG,
    date: window.date,
    generated_at: new Date().toISOString(),
    players: []
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(fallback, null, 2) + '\n', 'utf8');

  process.exit(1);
});
