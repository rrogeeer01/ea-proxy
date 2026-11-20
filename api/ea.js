import initialHistory from './birrareal-history.json' with { type:'json' };

export const eaPlatforms = new Set(['common-gen5', 'nx']);
const types = ['leagueMatch', 'friendlyMatch', 'playoffMatch'];
const maxAge = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);
const EA_PROXY = 'https://ea-proxy.vercel.app/api/ea';

function metric(value, max = 10000) {
  if (!['number','string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

function crestId(club) {
  const id = club?.details?.customKit?.crestAssetId ?? club?.details?.crestAssetId;
  return /^\d{1,12}$/.test(String(id ?? '')) ? String(id) : null;
}

export function normalizeMatch(raw, type, clubId) {
  const own = raw?.clubs?.[clubId];
  const opponent = Object.entries(raw?.clubs ?? {}).find(([id]) => id !== clubId)?.[1];
  if (!own || !opponent || !/^\d{1,24}$/.test(String(raw.matchId)) || !metric(raw.timestamp, 4102444800)) return null;
  const goalsFor = metric(own.goals, 99);
  const goalsAgainst = metric(opponent.goals, 99);
  if (goalsFor === null || goalsAgainst === null) return null;
  const players = Object.values(raw.players?.[clubId] ?? {}).filter(p => p && typeof p.playername === 'string').map(p => ({
    name:p.playername, goals:metric(p.goals), assists:metric(p.assists), rating:metric(p.rating,10),
    passes:metric(p.passesmade), attempts:metric(p.passattempts),
    position:typeof p.pos === 'string' ? p.pos : null,
    seconds:metric(p.secondsPlayed,18000), shots:metric(p.shots), saves:metric(p.saves),
    tackles:metric(p.tacklesmade), tackleAttempts:metric(p.tackleattempts), redCards:metric(p.redcards),
    onTarget:metric(p.shotsontarget), xg:metric(p.expectedgoals), keyPasses:metric(p.keypasses),
  }));
  return {
    id:String(raw.matchId),
    timestamp:Number(raw.timestamp),
    type,
    opponent:String(opponent.details?.name || 'Rival'),
    ownCrest:crestId(own),
    opponentCrest:crestId(opponent),
    goalsFor,
    goalsAgainst,
    players,
  };
}

async function eaJson(path, parameters, get = fetch) {
  const url = new URL(EA_PROXY);
  url.search = new URLSearchParams({ ...parameters, path });
  const response = await get(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

export async function searchClubs(name, platform) {
  const directId = String(name).trim().match(/^(?:.*clubId=)?([1-9]\d{0,15})$/)?.[1];
  if (directId) {
    const club = await lookupClub(directId, platform);
    if (club) return [club];
  }
  const data = await eaJson('allTimeLeaderboard/search',{ platform, clubName:name, maxResultCount:'50' });
  if (!Array.isArray(data)) throw new Error('Unknown EA search response');
  const clubs = new Map();
  for (const row of data) {
    const id = String(row?.clubInfo?.clubId ?? row?.clubId ?? '');
    const clubName = row?.clubInfo?.name || row?.clubName;
    if (/^[1-9]\d{0,15}$/.test(id) && typeof clubName === 'string' && clubName.trim()) {
      clubs.set(id,{id, name: clubName, platform});
    }
  }
  return [...clubs.values()];
}

export async function lookupClub(id, platform) {
  const data = await eaJson('clubs/info',{ platform, clubIds:id });
  const name = data?.[id]?.name;
  return typeof name === 'string' && name.trim() ? { id, name, platform } : null;
}

export async function syncDueClubs(db) {
  const due = await db.prepare(
    'SELECT DISTINCT link.platform, link.club_id AS id, COALESCE(sync.attempted,0) AS last ' +
    'FROM team_ea_clubs link LEFT JOIN ea_club_sync sync USING (platform,club_id) ' +
    'WHERE NOT EXISTS (SELECT 1 FROM team_archive WHERE team_slug=link.team_slug) ' +
    'AND COALESCE(sync.attempted,0)<=? ORDER BY last, link.platform, id LIMIT 2'
  ).bind(now()-maxAge).all();
  for (const club of due.results) await synchronize(db,club);
}

async function synchronize(db, {id:clubId, platform}) {
  const time = now();
  const claim = await db.prepare(
    'INSERT INTO ea_club_sync VALUES (?, ?, ?, 1) ON CONFLICT(platform, club_id) DO UPDATE SET attempted=excluded.attempted ' +
    'WHERE attempted <= ? RETURNING club_id'
  ).bind(platform,clubId,time,time-maxAge).first();
  if (!claim) return;
  const results = await Promise.allSettled(types.map(async type => {
    const data = await eaJson('clubs/matches',{ platform, clubIds:clubId, matchType:type, maxResultCount:'10' });
    if (!Array.isArray(data)) throw new Error('Unknown EA response');
    const matches = data.map(row => normalizeMatch(row,type,clubId));
    const writes = matches.filter(Boolean).map(m => db.prepare(
      'INSERT INTO ea_club_matches VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, club_id, id) ' +
      'DO UPDATE SET played=excluded.played, payload=excluded.payload'
    ).bind(platform,clubId,m.id,m.timestamp,JSON.stringify(m)));
    if (writes.length) await db.batch(writes);
    if (matches.includes(null)) throw new Error('Incomplete EA response');
  }));
  results.forEach((result,index) => {
    if (result.status === 'rejected') console.warn('EA sync',platform,clubId,types[index],result.reason?.message);
  });
  await db.prepare('UPDATE ea_club_sync SET warning=? WHERE platform=? AND club_id=? AND attempted=?')
    .bind(Number(results.some(r => r.status === 'rejected')),platform,clubId,time).run();
}

export async function recentEaMatches(db, club) {
  if (!club) return { club:null, matches:[], warning:false };
  const {id,platform} = club;
  const seed = platform === 'common-gen5' && id === '1074397' ? initialHistory : [];
  const history = new Map(seed.map(match => [match.id,match]));
  let warning = true;
  try {
    await synchronize(db,club);
    const [status, rows] = await Promise.all([
      db.prepare('SELECT warning FROM ea_club_sync WHERE platform=? AND club_id=?').bind(platform,id).first(),
      db.prepare('SELECT payload FROM ea_club_matches WHERE platform=? AND club_id=? ORDER BY played DESC,id DESC LIMIT 100')
        .bind(platform,id).all(),
    ]);
    for (const row of rows.results) {
      const match = JSON.parse(row.payload);
      const saved = history.get(match.id);
      if (saved && match.players.some(p => p.position === undefined)) {
        const byName = new Map(saved.players.map(p => [p.name, p]));
        match.players = match.players.map(p => ({...byName.get(p.name), ...p}));
      }
      history.set(match.id,match);
    }
    warning = Boolean(status?.warning);
  } catch (error) {
    console.error('EA match storage unavailable', error.message);
  }
  const matches = [...history.values()].sort((a,b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  return { club, warning, matches:matches.slice(0,100) };
}
