import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT_DIRECTORY = process.env.MCA_RESULTS_DIR || path.join(REPO_ROOT, 'data', 'mca-results');
const OUTPUT_FILE = process.env.MCA_OUTPUT_FILE || path.join(REPO_ROOT, 'mca-lifetime-points.json');
const CLUB_NAME = 'Blundering Buddies';
const CLUB_KEY = CLUB_NAME.toLocaleLowerCase('en-US');

// Chess.com's result export contains a player table followed by a second,
// unrelated club-summary table. Parse CSV quoting correctly and stop at the
// second heading, so summary rows cannot become fake players.
function parseCsv(source) {
  const input = source.replace(/^\uFEFF/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      record.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some(value => value.trim() !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV has an unterminated quoted field');
  record.push(field);
  if (record.some(value => value.trim() !== '')) records.push(record);
  return records;
}

function eventIdFromFilename(filename) {
  const match = filename.match(/(?:^|[-_])(\d{5,})\.csv$/i);
  if (!match) {
    throw new Error(`${filename}: filename must end in the Chess.com arena ID, e.g. -31118732.csv`);
  }
  return match[1];
}

function parseEvent(csv, filename) {
  const records = parseCsv(csv);
  if (!records.length) throw new Error(`${filename}: empty CSV`);

  const headers = records[0].map(value => value.trim().toLowerCase());
  const indexOf = name => headers.indexOf(name.toLowerCase());
  for (const required of ['Username', 'Club', 'Score', 'Status']) {
    if (indexOf(required) < 0) throw new Error(`${filename}: missing ${required} column`);
  }

  const clubRows = [];
  let clubSummaryPoints = null;
  let inClubSummary = false;

  for (let rowNumber = 1; rowNumber < records.length; rowNumber += 1) {
    const fields = records[rowNumber];
    if (fields[0]?.trim().toLowerCase() === 'club' &&
        fields[1]?.trim().toLowerCase() === 'total participants') {
      inClubSummary = true;
      continue;
    }

    if (inClubSummary) {
      if (fields[0]?.trim().toLocaleLowerCase('en-US') === CLUB_KEY) {
        const value = Number(fields[2]);
        if (Number.isFinite(value)) clubSummaryPoints = value;
      }
      continue;
    }

    const username = fields[indexOf('Username')]?.trim();
    const club = fields[indexOf('Club')]?.trim();
    const status = fields[indexOf('Status')]?.trim().toLowerCase();
    const rawScore = fields[indexOf('Score')]?.trim();

    if (club?.toLocaleLowerCase('en-US') !== CLUB_KEY) continue;
    if (!username || !/^\d+$/.test(rawScore ?? '')) {
      throw new Error(`${filename}: invalid username or score at CSV record ${rowNumber + 1}`);
    }
    clubRows.push({ username, club: CLUB_NAME, points: Number(rawScore), status });
  }

  if (!inClubSummary) throw new Error(`${filename}: expected Chess.com club-summary section was not found`);
  if (clubSummaryPoints === null) throw new Error(`${filename}: Blundering Buddies missing from club summary`);

  // Chess.com exports use `winner` and `withdrew` for valid scoring results.
  // A `removed` result sometimes does and sometimes does not contribute to the
  // official club score. Reconcile against the exported club total, rather than
  // assuming that every non-`registered` status is disqualified.
  const candidates = [
    clubRows.filter(row => row.status !== 'removed' && row.status !== 'fpv_removed'),
    clubRows.filter(row => row.status !== 'fpv_removed'),
    clubRows
  ];
  const selected = candidates.find(rows => rows.reduce((sum, row) => sum + row.points, 0) === clubSummaryPoints);
  if (!selected) {
    throw new Error(`${filename}: no unambiguous status rule matches Chess.com's official ${clubSummaryPoints} club points`);
  }

  const players = new Map();
  for (const { username, club, points } of selected) {
    const key = username.toLocaleLowerCase('en-US');
    if (players.has(key)) throw new Error(`${filename}: duplicate player ${username}`);
    players.set(key, { username, club, points });
  }
  return { players: [...players.values()], clubSummaryPoints };
}

async function main() {
  const filenames = (await fs.readdir(INPUT_DIRECTORY))
    .filter(filename => filename.toLowerCase().endsWith('.csv'))
    .sort((a, b) => a.localeCompare(b));

  if (filenames.length === 0) {
    throw new Error(`No MCA result CSV files found in ${INPUT_DIRECTORY}`);
  }

  const usedEventIds = new Set();
  const leaderboard = new Map();
  const events = [];

  for (const filename of filenames) {
    const eventId = eventIdFromFilename(filename);
    if (usedEventIds.has(eventId)) {
      throw new Error(`Arena ${eventId} appears more than once; rename or remove the duplicate CSV`);
    }
    usedEventIds.add(eventId);

    const csv = await fs.readFile(path.join(INPUT_DIRECTORY, filename), 'utf8');
    const event = parseEvent(csv, filename);
    const includedPoints = event.players.reduce((sum, player) => sum + player.points, 0);
    if (includedPoints !== event.clubSummaryPoints) {
      throw new Error(`${filename}: summed ${includedPoints} Blundering Buddies points, but Chess.com reports ${event.clubSummaryPoints}; check the CSV before publishing`);
    }
    events.push({
      arenaId: eventId,
      file: filename,
      players: event.players.length,
      points: includedPoints,
      officialClubScore: event.clubSummaryPoints
    });

    for (const player of event.players) {
      const key = player.username.toLocaleLowerCase('en-US');
      const record = leaderboard.get(key) || {
        username: player.username,
        club: CLUB_NAME,
        points: 0,
        mcasPlayed: 0,
        eventPoints: []
      };
      record.points += player.points;
      record.mcasPlayed += 1;
      record.eventPoints.push({ arenaId: eventId, points: player.points });
      leaderboard.set(key, record);
    }
  }

  const players = [...leaderboard.values()]
    .sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));
  const result = {
    version: 1,
    club: CLUB_NAME,
    eventsProcessed: events.length,
    playersTracked: players.length,
    totalPoints: players.reduce((sum, player) => sum + player.points, 0),
    events,
    players
  };

  let previous;
  try { previous = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    const { updatedAt: unused, ...existing } = previous;
    if (JSON.stringify(existing) === JSON.stringify(result)) {
      console.log(`Already current: ${events.length} MCA(s), ${players.length} players`);
      return;
    }
  }

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify({ ...result, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`Updated lifetime standings: ${events.length} MCA(s), ${players.length} players, ${result.totalPoints} points`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
