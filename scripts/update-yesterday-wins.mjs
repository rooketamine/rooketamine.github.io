import fs from 'node:fs/promises';

const CLUB_SLUG = 'blundering-buddies';
const OUTPUT_FILE = 'daily-points-race.json';
const FALLBACK_AVATAR = 'https://www.chess.com/bundles/web/images/user-image.007dad08.svg';
const USER_AGENT = 'rooketamine.github.io daily points race counter';
const CONCURRENCY = 8;
const RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const SCORING = {
  rapid: { win: 15, draw: 5 },
  blitz: { win: 9, draw: 3 },
  bullet: { win: 3, draw: 1 }
};

const DRAW_RESULTS = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient'
]);

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function utcDateKey(date){
  return date.toISOString().slice(0, 10);
}

function getRaceWindowUTC(){
  const now = new Date();
  const nowMs = now.getTime();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const tenHoursMs = 10 * 60 * 60 * 1000;

  let mode;
  let title;
  let startMs;
  let endMs;

  if(nowMs < todayStartMs + tenHoursMs){
    mode = 'winner';
    title = "Yesterday's Champion";
    startMs = todayStartMs - 24 * 60 * 60 * 1000;
    endMs = todayStartMs;
  }else{
    mode = 'race';
    title = "Today's Points Race";
    startMs = todayStartMs;
    endMs = nowMs;
  }

  const start = new Date(startMs);
  const end = new Date(endMs);

  return {
    mode,
    title,
    date: utcDateKey(start),
    startMs,
    endMs,
    year: String(start.getUTCFullYear()),
    month: String(start.getUTCMonth() + 1).padStart(2, '0'),
    window_start: start.toISOString(),
    window_end: end.toISOString()
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

function getUserResult(game, usernameLower){
  const whiteName = String(game?.white?.username || '').toLowerCase();
  const blackName = String(game?.black?.username || '').toLowerCase();

  if(whiteName === usernameLower) return String(game?.white?.result || '').toLowerCase();
  if(blackName === usernameLower) return String(game?.black?.result || '').toLowerCase();

  return '';
}

function emptyFormatScore(){
  return {
    points: 0,
    wins: 0,
    draws: 0
  };
}

function countPointsFromGames(games, username, window){
  const usernameLower = username.toLowerCase();

  const byFormat = {
    rapid: emptyFormatScore(),
    blitz: emptyFormatScore(),
    bullet: emptyFormatScore()
  };

  let points = 0;
  let wins = 0;
  let draws = 0;

  for(const game of games || []){
    const endTimeMs = Number(game.end_time || 0) * 1000;

    if(endTimeMs < window.startMs || endTimeMs >= window.endMs) continue;

    const format = String(game.time_class || '').toLowerCase();

    if(!SCORING[format]) continue;

    const result = getUserResult(game, usernameLower);

    if(result === 'win'){
      const score = SCORING[format].win;

      points += score;
      wins++;

      byFormat[format].points += score;
      byFormat[format].wins++;
    }else if(DRAW_RESULTS.has(result)){
      const score = SCORING[format].draw;

      points += score;
      draws++;

      byFormat[format].points += score;
      byFormat[format].draws++;
    }
  }

  return {
    username,
    points,
    wins,
    draws,
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
        points: 0,
        wins: 0,
        draws: 0,
        byFormat: {
          rapid: emptyFormatScore(),
          blitz: emptyFormatScore(),
          bullet: emptyFormatScore()
        }
      };
    }

    return countPointsFromGames(archive.games || [], username, window);
  }catch(err){
    console.warn(`Could not count ${username}: ${err.message}`);

    return {
      username,
      points: 0,
      wins: 0,
      draws: 0,
      byFormat: {
        rapid: emptyFormatScore(),
        blitz: emptyFormatScore(),
        bullet: emptyFormatScore()
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
  const window = getRaceWindowUTC();

  console.log(`${window.mode === 'winner' ? 'Locking' : 'Updating'} ${CLUB_SLUG} points for ${window.date} UTC...`);
  console.log(`Window: ${window.window_start} to ${window.window_end}`);

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
    .filter(p => p.points > 0)
    .sort((a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.draws - a.draws ||
      a.username.localeCompare(b.username)
    )
    .slice(0, 3);

  const players = await Promise.all(leaders.map(async player => ({
    username: player.username,
    points: player.points,
    wins: player.wins,
    draws: player.draws,
    avatar: await getAvatar(player.username),

    rapid: player.byFormat.rapid,
    blitz: player.byFormat.blitz,
    bullet: player.byFormat.bullet,

    rapid_points: player.byFormat.rapid.points,
    blitz_points: player.byFormat.blitz.points,
    bullet_points: player.byFormat.bullet.points
  })));

  const output = {
    ready: true,
    status: 'ready',
    club: CLUB_SLUG,
    mode: window.mode,
    title: window.title,
    date: window.date,
    generated_at: new Date().toISOString(),
    window_start: window.window_start,
    window_end: window.window_end,
    total_members_checked: usernames.length,
    scoring: {
      rapid: { win: 15, draw: 5 },
      blitz: { win: 9, draw: 3 },
      bullet: { win: 3, draw: 1 }
    },
    note: window.mode === 'winner'
      ? 'Final podium is shown until 10:00 UTC.'
      : 'Live race updates every 3 hours after 10:00 UTC.',
    players
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`Saved ${OUTPUT_FILE}`);
  console.log(JSON.stringify(players, null, 2));
}

main().catch(async err => {
  console.error(err);

  const window = getRaceWindowUTC();

  const fallback = {
    ready: false,
    status: 'counting',
    club: CLUB_SLUG,
    mode: window.mode,
    title: window.title,
    date: window.date,
    generated_at: new Date().toISOString(),
    players: []
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(fallback, null, 2) + '\n', 'utf8');

  process.exit(1);
});
