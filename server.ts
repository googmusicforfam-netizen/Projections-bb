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

interface TeamDefense {
  oppPpg: number;
  ppg: number;
  record?: string;
}

// Memory cache for overnight / daily slate caching with fast 2-minute refresh for game statuses
let cache: {
  timestamp: number;
  dateStr: string;
  data: any;
} | null = null;

async function fetchLiveNbaRostersAndData(clientLocalDateStr: string) {
  // Check if cache is fresh (less than 60 seconds)
  if (cache && Date.now() - cache.timestamp < 60000 && cache.dateStr === clientLocalDateStr) {
    return cache.data;
  }

  // 1. Fetch live scoreboard for tonight's games
  const sbRes = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard');
  if (!sbRes.ok) {
    throw new Error(`Failed to fetch NBA scoreboard: HTTP ${sbRes.status}`);
  }
  const sbData = await sbRes.json();

  const events = sbData.events || [];
  if (events.length === 0) {
    const emptyResult = {
      date: clientLocalDateStr,
      hasGamesTonight: false,
      noGamesMessage: 'No NBA games scheduled for tonight in the 2026-27 season.',
      games: [],
      keyInsights: [],
      allPlayers: []
    };
    cache = { timestamp: Date.now(), dateStr: clientLocalDateStr, data: emptyResult };
    return emptyResult;
  }

  // 2. Fetch team defensive stats from standings
  const standingsMap: Record<string, TeamDefense> = {};
  try {
    const standingsRes = await fetch('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings');
    if (standingsRes.ok) {
      const standingsData = await standingsRes.json();
      for (const conf of (standingsData.children || [])) {
        for (const entry of (conf.standings?.entries || [])) {
          const teamName = entry.team?.displayName;
          const oppPpgStat = entry.stats?.find((s: any) => s.name === 'avgPointsAgainst');
          const ppgStat = entry.stats?.find((s: any) => s.name === 'avgPointsFor');
          const recordStat = entry.stats?.find((s: any) => s.name === 'overall');
          if (teamName) {
            standingsMap[teamName] = {
              oppPpg: oppPpgStat ? Number(oppPpgStat.value) : 114,
              ppg: ppgStat ? Number(ppgStat.value) : 114,
              record: recordStat?.displayValue
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not fetch standings for defensive ratings:', err);
  }

  const oppPpgList = Object.values(standingsMap).map(s => s.oppPpg).filter(Boolean);
  const avgLeagueOppPpg = oppPpgList.length > 0 ? (oppPpgList.reduce((a, b) => a + b, 0) / oppPpgList.length) : 114;

  // 3. Fetch active injuries for all teams
  const teamInjuriesMap: Record<string, RawInjury[]> = {};
  const outPlayers = new Set<string>();
  const injuryDetailsMap = new Map<string, { status: string; desc: string }>();

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
            const desc = inj.details?.type || inj.shortComment || 'Injury';
            if (athleteName) {
              injuryDetailsMap.set(athleteName, { status: inj.status || 'Injured', desc });
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

  // 4. Extract teams playing tonight
  const teamsPlaying: Array<{ id: string; teamName: string; opponent: string; isHome: boolean; gameStatus: string }> = [];
  const gamesList: any[] = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors || [];
    const homeTeamComp = competitors.find((c: any) => c.homeAway === 'home');
    const awayTeamComp = competitors.find((c: any) => c.homeAway === 'away');

    const homeTeam = homeTeamComp?.team?.displayName || 'Home Team';
    const awayTeam = awayTeamComp?.team?.displayName || 'Away Team';
    const homeScore = homeTeamComp?.score ? homeTeamComp.score : null;
    const awayScore = awayTeamComp?.score ? awayTeamComp.score : null;
    const statusText = ev.status?.type?.detail || ev.status?.type?.shortDetail || 'Tonight';

    gamesList.push({
      id: ev.id,
      awayTeam,
      homeTeam,
      awayScore: homeScore === '0' && statusText.includes('PM') ? null : homeScore,
      homeScore: homeScore === '0' && statusText.includes('PM') ? null : homeScore,
      status: statusText,
      time: ev.status?.type?.shortDetail || 'Tip-off'
    });

    if (homeTeamComp && awayTeamComp) {
      teamsPlaying.push({
        id: homeTeamComp.id,
        teamName: homeTeam,
        opponent: awayTeam,
        isHome: true,
        gameStatus: statusText
      });
      teamsPlaying.push({
        id: awayTeamComp.id,
        teamName: awayTeam,
        opponent: homeTeam,
        isHome: false,
        gameStatus: statusText
      });
    }
  }

  // 5. Fetch complete active rosters for all teams playing tonight
  // Respect trades and roster moves by querying current official team rosters
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

  // Also fetch game summaries to get primary 2026-27 season leader stats (PPG, RPG, APG, MPG)
  const summaryPromises = events.map(async (ev: any) => {
    try {
      const sRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${ev.id}`);
      if (sRes.ok) return await sRes.json();
    } catch (e) {
      console.warn(`Summary error for game ${ev.id}:`, e);
    }
    return null;
  });

  const [rosterResults, summaries] = await Promise.all([
    Promise.all(rosterPromises),
    Promise.all(summaryPromises)
  ]);

  // Build stats lookup from game summaries
  const playerStatsLookup = new Map<string, { ppg: number; rpg: number; apg: number; spg: number; bpg: number; mpg: number }>();
  for (const summary of summaries) {
    if (summary && summary.leaders) {
      for (const teamLeaderGroup of summary.leaders) {
        if (teamLeaderGroup.leaders) {
          for (const statCat of teamLeaderGroup.leaders) {
            for (const l of (statCat.leaders || [])) {
              if (l.athlete) {
                const nameKey = l.athlete.displayName?.trim().toLowerCase();
                let st = playerStatsLookup.get(nameKey);
                if (!st) {
                  st = { ppg: 0, rpg: 0, apg: 0, spg: 0, bpg: 0, mpg: 0 };
                  playerStatsLookup.set(nameKey, st);
                }
                for (const s of (l.statistics || [])) {
                  if (s.name === 'avgPoints') st.ppg = Number(s.value) || 0;
                  if (s.name === 'avgRebounds') st.rpg = Number(s.value) || 0;
                  if (s.name === 'avgAssists') st.apg = Number(s.value) || 0;
                  if (s.name === 'avgMinutes') st.mpg = Number(s.value) || 0;
                  if (s.name === 'avgSteals') st.spg = Number(s.value) || 0;
                  if (s.name === 'avgBlocks') st.bpg = Number(s.value) || 0;
                }
                if (statCat.name === 'pointsPerGame' && st.ppg === 0) st.ppg = Number(l.value) || 0;
                if (statCat.name === 'reboundsPerGame' && st.rpg === 0) st.rpg = Number(l.value) || 0;
                if (statCat.name === 'assistsPerGame' && st.apg === 0) st.apg = Number(l.value) || 0;
              }
            }
          }
        }
      }
    }
  }

  // 6. Assemble Full Active Player Pool (starters AND bench rotation)
  // Remove anyone injured, ruled out, or no longer on that team
  const allPlayers: any[] = [];
  const processedPlayerNames = new Set<string>();

  for (const teamRoster of rosterResults) {
    const oppDefense = standingsMap[teamRoster.opponent]?.oppPpg || avgLeagueOppPpg;
    const defDiff = oppDefense - avgLeagueOppPpg;

    let matchupRating: 'Great' | 'Good' | 'Tough' = 'Good';
    if (defDiff > 3) matchupRating = 'Great';
    else if (defDiff < -3) matchupRating = 'Tough';

    for (const athlete of teamRoster.athletes) {
      const name = athlete.displayName?.trim();
      if (!name) continue;
      const lowerName = name.toLowerCase();

      // Check if ruled out or inactive
      if (outPlayers.has(lowerName)) {
        continue; // Rule out completely per requirement
      }
      if (athlete.status?.type === 'inactive') {
        continue; // Remove inactive roster players
      }
      if (processedPlayerNames.has(lowerName)) {
        continue;
      }
      processedPlayerNames.add(lowerName);

      const injInfo = injuryDetailsMap.get(lowerName);
      const isGTD = injInfo && !outPlayers.has(lowerName);

      // Check season stats from leaderboards, or estimate from athlete position / rotation profile
      const knownStats = playerStatsLookup.get(lowerName);
      let ppg = knownStats?.ppg || 0;
      let rpg = knownStats?.rpg || 0;
      let apg = knownStats?.apg || 0;
      let spg = knownStats?.spg || 0;
      let bpg = knownStats?.bpg || 0;
      let mpg = knownStats?.mpg || 0;

      const pos = athlete.position?.abbreviation || 'G';
      const experienceYears = athlete.experience?.years || 0;

      // Bench or secondary player projection modeling
      let baseFp = 0;
      if (knownStats && (ppg > 0 || rpg > 0 || apg > 0)) {
        baseFp = (ppg * 1.0) + (rpg * 1.2) + (apg * 1.5) + (spg * 3.0) + (bpg * 3.0);
        if (baseFp < 15 && ppg > 10) baseFp = ppg * 1.6;
      } else {
        // Bench / rotation player without top-tier leader stats
        // Model rotation minutes: rotation bench players typically play 14-22 min (~0.75-0.9 FP/min = 12-19 FP)
        const depthMinutes = athlete.jersey ? 18 : 14;
        mpg = depthMinutes;
        ppg = Math.round((depthMinutes * 0.45) * 10) / 10;
        rpg = pos === 'C' ? 5.2 : pos === 'F' ? 3.8 : 2.2;
        apg = pos === 'G' ? 3.1 : 1.4;
        baseFp = (ppg * 1.0) + (rpg * 1.2) + (apg * 1.5) + (0.7 * 3.0) + (0.4 * 3.0);
      }

      // Matchup adjustment
      const matchupMultiplier = matchupRating === 'Great' ? 1.08 : matchupRating === 'Tough' ? 0.92 : 1.0;
      const finalProjection = Math.max(8.0, Math.round(baseFp * matchupMultiplier * 10) / 10);

      // Projected ownership calculation for GPP tournament play
      // High projection & great matchup -> higher ownership
      // Deep rotation / bench players -> lower ownership (sub 8%), giving high GPP leverage
      let projectedOwnership = 5;
      if (finalProjection > 40) projectedOwnership = 22;
      else if (finalProjection > 32) projectedOwnership = 15;
      else if (finalProjection > 24) projectedOwnership = 10;
      else if (finalProjection > 16) projectedOwnership = 6;
      else projectedOwnership = 3;

      if (matchupRating === 'Great') projectedOwnership += 4;
      if (matchupRating === 'Tough') projectedOwnership = Math.max(2, projectedOwnership - 4);
      if (isGTD) projectedOwnership = Math.max(2, Math.round(projectedOwnership * 0.7));

      // Flag low-ownership, high-upside tournament plays
      // (Projection >= 18 FP and ownership <= 10%, or projection >= 28 and ownership <= 14%)
      const isTournamentGppValue =
        (finalProjection >= 20 && projectedOwnership <= 10) ||
        (finalProjection >= 16 && matchupRating === 'Great' && projectedOwnership <= 8);

      allPlayers.push({
        id: athlete.id,
        name,
        team: teamRoster.team,
        opponent: teamRoster.opponent,
        position: pos,
        headshot: athlete.headshot?.href || null,
        jersey: athlete.jersey || '',
        projection: finalProjection,
        projectedOwnership,
        isGppTarget: isTournamentGppValue,
        matchupRating,
        oppDefense,
        mpg,
        ppg,
        rpg,
        apg,
        status: isGTD ? `GTD (${injInfo.status})` : 'Active',
        injuryDetail: isGTD ? injInfo.desc : null,
        // Default salaries if no file uploaded yet
        dkSalary: null,
        fdSalary: null
      });
    }
  }

  // 7. Key Insights (5-8 alerts focused on injuries, rotation beneficiaries, and GPP leverage)
  const keyInsights: string[] = [];
  const reportedTeams = new Set<string>();

  for (const t of teamsPlaying) {
    if (reportedTeams.has(t.teamName)) continue;
    const teamOuts = (teamInjuriesMap[t.teamName] || []).filter(i => {
      const s = (i.status || '').toLowerCase();
      return s.includes('out') || s.includes('reserve');
    });

    if (teamOuts.length > 0) {
      reportedTeams.add(t.teamName);
      const star = teamOuts[0];
      const starName = star.athlete?.displayName || 'Key player';
      // Find top bench beneficiary on that team
      const teamPlayers = allPlayers.filter(p => p.team === t.teamName);
      const topBeneficiary = teamPlayers.find(p => p.name !== starName);

      keyInsights.push(
        `${starName} (${t.teamName}) is OUT (${star.details?.type || 'Injury'}), vacating significant usage and opening GPP rotation upside for ${topBeneficiary ? topBeneficiary.name : 'bench depth'}.`
      );
    }
    if (keyInsights.length >= 6) break;
  }

  // Big matchup advantages
  const greatMatchups = allPlayers.filter(p => p.matchupRating === 'Great').sort((a, b) => b.projection - a.projection);
  for (const gm of greatMatchups) {
    if (keyInsights.length >= 8) break;
    keyInsights.push(
      `${gm.name} (${gm.team}) faces ${gm.opponent}'s bottom-tier defense (${gm.oppDefense.toFixed(1)} OPP PPG allowed), offering elite tournament ceiling.`
    );
  }

  while (keyInsights.length < 5 && allPlayers.length > 0) {
    const p = allPlayers[keyInsights.length % allPlayers.length];
    keyInsights.push(
      `${p.name} carries tournament upside in ${p.team}'s rotation tonight against ${p.opponent}.`
    );
  }

  const result = {
    date: clientLocalDateStr,
    hasGamesTonight: true,
    games: gamesList,
    keyInsights: keyInsights.slice(0, 8),
    allPlayers
  };

  cache = {
    timestamp: Date.now(),
    dateStr: clientLocalDateStr,
    data: result
  };

  return result;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  const PORT = Number(process.env.PORT) || 3000;

  // Endpoint to fetch complete live NBA data with active rosters
  app.get('/api/nba-data', async (req, res) => {
    const now = new Date();
    const dateFormatted = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

    try {
      const data = await fetchLiveNbaRostersAndData(dateFormatted);
      res.json(data);
    } catch (error: any) {
      console.error('Error fetching live NBA rosters and data:', error);
      res.status(500).json({
        error: 'Unable to connect to live NBA roster data source',
        details: error.message || 'Unknown error',
        hasGamesTonight: false,
        noGamesMessage: 'Unable to load tonight\'s complete NBA rosters right now. Please click Refresh to try again.'
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
