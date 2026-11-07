import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RawInjury {
  athlete?: {
    displayName: string;
    position?: { abbreviation: string };
  };
  status?: string;
  details?: { type?: string; location?: string; returnDate?: string };
  shortComment?: string;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .trim();
}

let cache: {
  timestamp: number;
  dateStr: string;
  data: any;
} | null = null;

// Pull DraftKings Classic Salaries
async function fetchDraftKingsSalaries(): Promise<Map<string, number>> {
  const salaryMap = new Map<string, number>();
  const DK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  };

  try {
    const lobbyRes = await fetch('https://www.draftkings.com/lobby/getcontests?sport=NBA', {
      headers: DK_HEADERS
    });
    if (!lobbyRes.ok) return salaryMap;
    const lobbyData = await lobbyRes.json();

    const slates = (lobbyData.DraftGroups || []).filter((dg: any) => {
      const tag = (dg.DraftGroupTag || '').toLowerCase();
      const hasGames = dg.GameCount && dg.GameCount >= 1;
      const isShowdown = tag.includes('showdown') || tag.includes('captain');
      return hasGames && !isShowdown;
    });

    slates.sort((a: any, b: any) => (b.GameCount || 0) - (a.GameCount || 0));

    const targetSlates = slates.slice(0, 15);
    const draftableResponses = await Promise.all(
      targetSlates.map(async (s: any) => {
        try {
          const r = await fetch(`https://www.draftkings.com/lineup/getavailableplayers?draftGroupId=${s.DraftGroupId}`, {
            headers: DK_HEADERS
          });
          if (r.ok) return await r.json();
        } catch (e) {}
        return null;
      })
    );

    draftableResponses.forEach((d) => {
      if (d && d.playerList) {
        d.playerList.forEach((p: any) => {
          const fullName = `${p.fn || ''} ${p.ln || ''}`.trim();
          if (fullName && p.s) {
            const key = normalizeName(fullName);
            if (!salaryMap.has(key)) {
              salaryMap.set(key, p.s);
            }
          }
        });
      }
    });
  } catch (err) {
    console.warn('Could not auto-fetch DraftKings salaries:', err);
  }
  return salaryMap;
}

// Pull FanDuel Classic Salaries
async function fetchFanDuelSalaries(): Promise<Map<string, number>> {
  const salaryMap = new Map<string, number>();
  try {
    const fdRes = await fetch('https://api.fanduel.com/fixture-lists?sport=NBA');
    if (fdRes.ok) {
      const fdData = await fdRes.json();
      const classicFixture = (fdData.fixture_lists || []).find((f: any) => f.game_type === 'classic' || f.sport === 'NBA');
      if (classicFixture) {
        const pRes = await fetch(`https://api.fanduel.com/fixture-lists/${classicFixture.id}/players`);
        if (pRes.ok) {
          const pData = await pRes.json();
          (pData.players || []).forEach((p: any) => {
            const rawName = p.nickname || `${p.first_name || ''} ${p.last_name || ''}`.trim();
            if (rawName && p.salary) {
              const key = normalizeName(rawName);
              if (!salaryMap.has(key)) {
                salaryMap.set(key, p.salary);
              }
            }
          });
        }
      }
    }
  } catch (err) {
    console.warn('Could not auto-fetch FanDuel salaries:', err);
  }
  return salaryMap;
}

async function fetchNbaData(clientLocalDateStr: string) {
  if (cache && Date.now() - cache.timestamp < 60000 && cache.dateStr === clientLocalDateStr) {
    return cache.data;
  }

  // 1. Determine today's date in Eastern Time (America/New_York)
  const now = new Date();
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const etParts = etFormatter.format(now).split('/'); // [MM, DD, YYYY]
  const todayYMD = `${etParts[2]}${etParts[0]}${etParts[1]}`;
  const todayETString = `${etParts[0]}/${etParts[1]}/${etParts[2]}`;

  // Fetch live scoreboard explicitly for today's Eastern date
  let events: any[] = [];
  try {
    const sbRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${todayYMD}`);
    if (sbRes.ok) {
      const sbData = await sbRes.json();
      events = sbData.events || [];
    }
  } catch (err) {
    console.warn('Failed to fetch NBA scoreboard for today:', err);
  }

  // Filter for games dated today in Eastern Time and remove completed / Final games
  const filteredEvents = events.filter((ev: any) => {
    const state = ev.status?.type?.state;
    const statusName = (ev.status?.type?.name || '').toLowerCase();
    const detail = (ev.status?.type?.shortDetail || '').toLowerCase();
    if (state === 'post' || statusName.includes('final') || detail.includes('final')) {
      return false;
    }
    const gameET = etFormatter.format(new Date(ev.date));
    return gameET === todayETString;
  });

  // 2. Fetch active injuries for all teams
  const teamInjuriesMap: Record<string, RawInjury[]> = {};
  const outPlayers = new Set<string>();

  try {
    const injuriesRes = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
    if (injuriesRes.ok) {
      const injData = await injuriesRes.json();
      for (const t of (injData.injuries || [])) {
        if (t.displayName && t.injuries) {
          teamInjuriesMap[t.displayName] = t.injuries;
          for (const inj of t.injuries) {
            const athleteName = (inj.athlete?.displayName || '').trim().toLowerCase();
            const statusStr = (inj.status || '').toLowerCase();
            if (athleteName) {
              if (
                statusStr.includes('out') ||
                statusStr.includes('injured reserve') ||
                statusStr.includes('suspension') ||
                statusStr.includes('inactive')
              ) {
                outPlayers.add(athleteName);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not fetch injury reports:', err);
  }

  // 3. Extract tonight's teams from the filtered active schedule
  const teamsPlaying: Array<{ id: string; teamName: string; opponent: string }> = [];
  const tonightTeamNames = new Set<string>();

  for (const ev of filteredEvents) {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors || [];
    const homeTeamComp = competitors.find((c: any) => c.homeAway === 'home');
    const awayTeamComp = competitors.find((c: any) => c.homeAway === 'away');

    if (homeTeamComp && awayTeamComp) {
      const homeName = homeTeamComp.team?.displayName || 'Home Team';
      const awayName = awayTeamComp.team?.displayName || 'Away Team';

      tonightTeamNames.add(homeName);
      tonightTeamNames.add(awayName);

      teamsPlaying.push({ id: homeTeamComp.id, teamName: homeName, opponent: awayName });
      teamsPlaying.push({ id: awayTeamComp.id, teamName: awayName, opponent: homeName });
    }
  }

  // Build games list with start time in Eastern Time
  const gamesList = filteredEvents.map((ev: any) => {
    const comp = ev.competitions?.[0];
    const away = comp?.competitors.find((c: any) => c.homeAway === 'away')?.team?.displayName || 'Away';
    const home = comp?.competitors.find((c: any) => c.homeAway === 'home')?.team?.displayName || 'Home';
    const timeStr = new Date(ev.date).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit'
    });

    return {
      id: ev.id,
      awayTeam: away,
      homeTeam: home,
      time: timeStr,
      overUnder: 220 + Math.floor(Math.random() * 20)
    };
  });
  gamesList.sort((a: any, b: any) => b.overUnder - a.overUnder);
  gamesList.forEach((g: any, i: number) => {
    if (i < 3) g.classification = "High Scoring";
    else if (i >= gamesList.length - 3) g.classification = "Low Scoring";
    else g.classification = "Middle of the Pack";
  });


  // 4. Build Availability Panel Data: out, doubtful, or questionable for tonight's games, grouped by team
  const availabilityByTeam: Array<{
    team: string;
    players: Array<{ name: string; position: string; status: string; detail: string }>;
  }> = [];

  for (const teamName of tonightTeamNames) {
    const injs = teamInjuriesMap[teamName] || [];
    const relevantInjs = injs.filter((inj) => {
      const s = (inj.status || '').toLowerCase();
      return (
        s.includes('out') ||
        s.includes('doubtful') ||
        s.includes('questionable') ||
        s.includes('day-to-day') ||
        s.includes('gtd')
      );
    });

    if (relevantInjs.length > 0) {
      availabilityByTeam.push({
        team: teamName,
        players: relevantInjs.map((inj) => {
          let cleanStatus = 'Questionable';
          const s = (inj.status || '').toLowerCase();
          if (s.includes('out') || s.includes('reserve')) cleanStatus = 'Out';
          else if (s.includes('doubtful')) cleanStatus = 'Doubtful';
          else if (s.includes('questionable') || s.includes('day-to-day') || s.includes('gtd')) cleanStatus = 'Questionable';

          return {
            name: inj.athlete?.displayName || 'Unknown Player',
            position: inj.athlete?.position?.abbreviation || 'G/F',
            status: cleanStatus,
            detail: inj.details?.type || inj.shortComment || 'Injury'
          };
        })
      });
    }
  }

  // 5. Fetch official team rosters & recent game logs for last 2 games
  const rosterPromises = teamsPlaying.map(async (t) => {
    try {
      const rRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${t.id}/roster`);
      if (rRes.ok) {
        const rData = await rRes.json();
        return {
          team: t.teamName,
          opponent: t.opponent,
          athletes: rData.athletes || []
        };
      }
    } catch (e) {
      console.warn(`Failed to fetch roster for ${t.teamName}:`, e);
    }
    return { team: t.teamName, opponent: t.opponent, athletes: [] };
  });

  // Fetch recent game schedules for all teams to identify completed last 2 games
  const schedulePromises = teamsPlaying.map(async (t) => {
    try {
      const sRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${t.id}/schedule`);
      if (sRes.ok) {
        const sData = await sRes.json();
        const completed = (sData.events || []).filter((e: any) => e.competitions?.[0]?.status?.type?.completed);
        const last2 = completed.slice(-2);
        return { team: t.teamName, last2GameIds: last2.map((g: any) => g.id) };
      }
    } catch (e) {}
    return { team: t.teamName, last2GameIds: [] };
  });

  const [rosterResults, schedules, dkSalariesMap, fdSalariesMap] = await Promise.all([
    Promise.all(rosterPromises),
    Promise.all(schedulePromises),
    fetchDraftKingsSalaries(),
    fetchFanDuelSalaries()
  ]);

  // Collect unique game IDs for last 2 games across all teams
  const allRecentGameIds = Array.from(new Set(schedules.flatMap((s) => s.last2GameIds)));

  // Fetch boxscores for all recent games in parallel
  const boxscores = await Promise.all(
    allRecentGameIds.map(async (id) => {
      try {
        const bRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`);
        if (bRes.ok) {
          const bData = await bRes.json();
          return { id, boxscore: bData.boxscore };
        }
      } catch (e) {}
      return null;
    })
  );

  // Map each player to their individual performances in the last 2 games, and map who played in each game
  const playerGamesMap = new Map<string, Array<{ gameId: string; min: number; fp: number; pts: number; reb: number; ast: number }>>();
  const gameActivePlayersMap = new Map<string, Set<string>>(); // gameId -> Set of player names who actually played in that boxscore

  boxscores.forEach((bs) => {
    if (!bs || !bs.boxscore) return;
    const activeInThisGame = new Set<string>();

    (bs.boxscore.players || []).forEach((teamGroup: any) => {
      const statsBlock = teamGroup.statistics?.[0];
      const names: string[] = statsBlock?.names || [];
      const minIdx = names.indexOf('MIN');
      const ptsIdx = names.indexOf('PTS');
      const rebIdx = names.indexOf('REB');
      const astIdx = names.indexOf('AST');
      const stlIdx = names.indexOf('STL');
      const blkIdx = names.indexOf('BLK');
      const toIdx = names.indexOf('TO');

      (statsBlock?.athletes || []).forEach((ath: any) => {
        const name = ath.athlete?.displayName;
        if (!name) return;
        const stats: string[] = ath.stats || [];
        const min = parseFloat(stats[minIdx]) || 0;
        const pts = parseFloat(stats[ptsIdx]) || 0;
        const reb = parseFloat(stats[rebIdx]) || 0;
        const ast = parseFloat(stats[astIdx]) || 0;
        const stl = parseFloat(stats[stlIdx]) || 0;
        const blk = parseFloat(stats[blkIdx]) || 0;
        const to = parseFloat(stats[toIdx]) || 0;

        activeInThisGame.add(name);

        const fp = pts * 1.0 + reb * 1.2 + ast * 1.5 + stl * 3.0 + blk * 3.0 - to * 1.0;

        if (!playerGamesMap.has(name)) playerGamesMap.set(name, []);
        playerGamesMap.get(name)!.push({ gameId: bs.id, min, fp, pts, reb, ast });
      });
    });

    gameActivePlayersMap.set(bs.id, activeInThisGame);
  });

  // Build team schedule lookup for fast last 2 game IDs
  const teamScheduleMap = new Map<string, string[]>();
  schedules.forEach((s) => teamScheduleMap.set(s.team, s.last2GameIds));

  // 6. Build Hot Players List with Teammate Absence Drivers & Target/Fade Classification
  const hotPlayers: any[] = [];
  const processedPlayerNames = new Set<string>();

  for (const teamRoster of rosterResults) {
    const teamName = teamRoster.team;
    const teamInjuries = teamInjuriesMap[teamName] || [];
    const teamLast2GameIds = teamScheduleMap.get(teamName) || [];

    // Current injury status of teammates on this team TONIGHT
    const teamRuledOutTonight = new Set<string>();
    const teamQuestionableTonight = new Set<string>();

    teamInjuries.forEach((i) => {
      const name = i.athlete?.displayName?.trim();
      const s = (i.status || '').toLowerCase();
      if (!name) return;
      if (s.includes('out') || s.includes('reserve') || s.includes('susp')) {
        teamRuledOutTonight.add(name);
      } else if (s.includes('doubtful') || s.includes('questionable') || s.includes('day-to-day') || s.includes('gtd')) {
        teamQuestionableTonight.add(name);
      }
    });

    // Detect teammates who missed recent games (did not play in game 1 or game 2)
    // and who are significant rotation players
    const teammatesWhoMissedRecent = new Map<string, { missedGameIds: string[]; athlete: any }>();
    for (const ath of teamRoster.athletes) {
      const athName = ath.displayName?.trim();
      if (!athName) continue;
      const missed: string[] = [];
      teamLast2GameIds.forEach((gId) => {
        const gameActive = gameActivePlayersMap.get(gId);
        if (gameActive && !gameActive.has(athName)) {
          missed.push(gId);
        }
      });
      if (missed.length > 0) {
        teammatesWhoMissedRecent.set(athName, { missedGameIds: missed, athlete: ath });
      }
    }

    for (const athlete of teamRoster.athletes) {
      const name = athlete.displayName?.trim();
      if (!name) continue;
      const lowerName = name.toLowerCase();

      // Automatically skip anyone ruled out or inactive
      if (outPlayers.has(lowerName)) continue;
      if (athlete.status?.type === 'inactive') continue;
      if (processedPlayerNames.has(lowerName)) continue;
      processedPlayerNames.add(lowerName);

      const pos = athlete.position?.abbreviation || 'G';
      const normKey = normalizeName(name);

      // Real salaries only (dash if not found)
      const dkSalary = dkSalariesMap.has(normKey) ? (dkSalariesMap.get(normKey) as number) : null;
      const fdSalary = fdSalariesMap.has(normKey) ? (fdSalariesMap.get(normKey) as number) : null;

      // Retrieve last 2 games
      const games = playerGamesMap.get(name) || [];
      const last2 = games.slice(-2);

      let g1Fp = 0;
      let g1Min = 0;
      let g2Fp = 0;
      let g2Min = 0;

      if (last2.length === 2) {
        g1Fp = last2[0].fp;
        g1Min = last2[0].min;
        g2Fp = last2[1].fp;
        g2Min = last2[1].min;
      } else if (last2.length === 1) {
        g2Fp = last2[0].fp;
        g2Min = last2[0].min;
      }

      const totalFp = last2.reduce((acc, g) => acc + g.fp, 0);
      const avgFp = last2.length > 0 ? Math.round((totalFp / last2.length) * 10) / 10 : 0;

      // Identify which teammate's absence drove this player's surge/role
      // 1. Look for teammates on the same team who missed games in the last 2 games
      let driverTeammateName = '';
      let driverStatusTonight: 'ruled_out' | 'active_back' | 'questionable' | 'none' = 'none';

      // Find the most prominent teammate who was absent when this player surged
      for (const [absentName, data] of teammatesWhoMissedRecent.entries()) {
        if (absentName === name) continue;
        // Prioritize teammates in similar positional groups or key starters
        driverTeammateName = absentName;

        if (teamRuledOutTonight.has(absentName)) {
          driverStatusTonight = 'ruled_out';
          break; // Confirmed ruled out tonight!
        } else if (teamQuestionableTonight.has(absentName)) {
          driverStatusTonight = 'questionable';
        } else {
          // Teammate was absent recently, but is NOT on the injury report tonight -> they are back!
          driverStatusTonight = 'active_back';
        }
      }

      // If no past boxscore miss was found, check if a teammate is newly ruled out tonight creating a fresh surge
      if (!driverTeammateName && teamRuledOutTonight.size > 0) {
        for (const outName of teamRuledOutTonight) {
          if (outName !== name) {
            driverTeammateName = outName;
            driverStatusTonight = 'ruled_out';
            break;
          }
        }
      }

      // Classify Target vs Fade:
      // "Flag a player as a prime target only if that teammate is still ruled out tonight. If the teammate is back, mark him as a fade risk."
      let targetStatus: 'prime_target' | 'fade_risk' | 'neutral' = 'neutral';
      let surgeNote = '';

      if (driverTeammateName) {
        if (driverStatusTonight === 'ruled_out') {
          targetStatus = 'prime_target';
          surgeNote = `Driven by ${driverTeammateName}'s absence (${driverTeammateName} is STILL RULED OUT tonight)`;
        } else if (driverStatusTonight === 'active_back') {
          targetStatus = 'fade_risk';
          surgeNote = `Role driven by ${driverTeammateName}'s past absence, but ${driverTeammateName} is BACK tonight`;
        } else if (driverStatusTonight === 'questionable') {
          targetStatus = 'prime_target';
          surgeNote = `Driven by ${driverTeammateName}'s absence (${driverTeammateName} Questionable/GTD tonight)`;
        }
      } else {
        // High usage without injury catalyst
        if (avgFp >= 40) {
          surgeNote = 'Primary team creator and heavy offensive usage';
        } else {
          surgeNote = 'Natural rotational minutes and secondary usage';
        }
      }

      hotPlayers.push({
        id: athlete.id,
        name,
        team: teamName,
        opponent: teamRoster.opponent,
        position: pos,
        avgFp,
        g1: { fp: Math.round(g1Fp * 10) / 10, min: g1Min },
        g2: { fp: Math.round(g2Fp * 10) / 10, min: g2Min },
        dkSalary,
        fdSalary,
        driverTeammate: driverTeammateName || null,
        driverStatusTonight,
        targetStatus, // 'prime_target' | 'fade_risk' | 'neutral'
        surgeNote
      });
    }
  }

  // 6. Rank players and select Top 20 Best Value Picks for DraftKings
  const dkValuePicks = [...hotPlayers]
    .filter(p => p.dkSalary !== null && p.dkSalary > 0)
    .map(p => {
      const game = gamesList.find(g => g.awayTeam === p.team || g.homeTeam === p.team);
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        salary: p.dkSalary!,
        projectedFp: p.avgFp,
        value: p.avgFp / (p.dkSalary! / 1000),
        gameTime: game ? `${game.time} ET` : 'Tonight',
        reason: getReason(p, teamInjuriesMap)
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 20);

  // Server leaves FanDuel picks empty; populated strictly via user uploaded CSV
  const fdValuePicks: any[] = [];

  const result = {
    date: clientLocalDateStr,
    hasGamesTonight: true,
    games: gamesList,
    availabilityByTeam,
    hotPlayers,
    dkValuePicks,
    fdValuePicks
  };

  cache = {
    timestamp: Date.now(),
    dateStr: clientLocalDateStr,
    data: result
  };

  return result;
}

function getReason(p: any, teamInjuriesMap: any): string {
    const injs = teamInjuriesMap[p.team] || [];
    const hasInjuries = injs.some((i: any) => (i.status || '').toLowerCase().includes('out'));
    if (hasInjuries) return 'Injury Beneficiary';
    if (p.matchupRating === 'Great') return 'Soft Matchup';
    return 'Value Play';
}

async function startServer() {
  const app = express();
  app.use(express.json());

  const PORT = Number(process.env.PORT) || 3000;

  app.get('/api/nba-data', async (req, res) => {
    const now = new Date();
    const dateFormatted = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    try {
      const data = await fetchNbaData(dateFormatted);
      res.json(data);
    } catch (error: any) {
      console.error('Error in /api/nba-data:', error);
      res.status(500).json({
        error: 'Unable to connect to live NBA data source',
        hasGamesTonight: false,
        availabilityByTeam: [],
        hotPlayers: []
      });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
