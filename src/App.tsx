/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { RefreshCw, Flame, AlertCircle, Info, Upload } from 'lucide-react';

interface Game {
  id: string;
  awayTeam: string;
  homeTeam: string;
  time: string;
  classification: string;
}

interface InjuredPlayer {
  name: string;
  position: string;
  status: string; // 'Out' | 'Doubtful' | 'Questionable'
  detail: string;
}

interface TeamAvailability {
  team: string;
  players: InjuredPlayer[];
}

interface GamePerformance {
  fp: number;
  min: number;
}

interface HotPlayer {
  id: string;
  name: string;
  team: string;
  opponent: string;
  position: string;
  avgFp: number;
  g1: GamePerformance;
  g2: GamePerformance;
  dkSalary: number | null;
  fdSalary: number | null;
  driverTeammate: string | null;
  driverStatusTonight: 'ruled_out' | 'active_back' | 'questionable' | 'none';
  targetStatus: 'prime_target' | 'fade_risk' | 'neutral';
  surgeReason: string;
}

interface ValuePick {
  name: string;
  team: string;
  value: number;
  reason: string;
}

interface NbaApiResponse {
  date: string;
  hasGamesTonight: boolean;
  noGamesMessage?: string;
  games: Game[];
  availabilityByTeam: TeamAvailability[];
  hotPlayers: HotPlayer[];
  dkValuePicks: ValuePick[];
  fdValuePicks: ValuePick[];
}

// Normalize player names to ignore accents, periods, junior/senior, roman numerals, and special characters
function normalizePlayerName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z]/g, '')
    .trim();
}

interface ParsedFanDuelPlayer {
  name: string;
  salary: number;
  team?: string;
  position?: string;
}

// Simple RFC-compliant CSV parser that strips BOM and flexibly identifies Player Name, Team, Position, and Salary
function parseFanDuelCSV(text: string): ParsedFanDuelPlayer[] {
  // Strip UTF-8 Byte Order Mark if present
  const cleanText = text.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSV file is empty or missing data rows.');
  }

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const rawHeaders = parseLine(lines[0]);
  const headers = rawHeaders.map(h => h.trim().toLowerCase());

  const findColIndex = (candidates: string[]): number => {
    for (const cand of candidates) {
      const cleanCand = cand.replace(/[^a-z0-9]/g, '');
      const idx = headers.findIndex(h => {
        const cleanH = h.replace(/[^a-z0-9]/g, '');
        return cleanH === cleanCand;
      });
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const nameCol = findColIndex(['player name', 'nickname', 'player', 'name', 'full name', 'athlete']);
  const firstCol = findColIndex(['first name', 'firstname', 'first']);
  const lastCol = findColIndex(['last name', 'lastname', 'last']);
  const salCol = findColIndex(['salary', 'salary ($)', 'sal', 'cost', 'price']);
  const teamCol = findColIndex(['team', 'team abbreviation', 'teamabbrev', 'tm']);
  const posCol = findColIndex(['position', 'pos', 'roster position']);

  if (salCol === -1) {
    throw new Error('Could not find Salary column in CSV.');
  }
  if (nameCol === -1 && (firstCol === -1 || lastCol === -1)) {
    throw new Error('Could not find Player Name or Nickname column in CSV.');
  }

  const players: ParsedFanDuelPlayer[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    let name = '';
    if (nameCol !== -1 && vals[nameCol]) {
      name = vals[nameCol];
    } else if (firstCol !== -1 && lastCol !== -1) {
      name = `${vals[firstCol] || ''} ${vals[lastCol] || ''}`.trim();
    }

    const rawSal = vals[salCol] || '';
    const salary = parseInt(rawSal.replace(/[^0-9]/g, ''), 10);
    const team = teamCol !== -1 ? vals[teamCol] : '';
    const position = posCol !== -1 ? vals[posCol] : '';

    if (name && !isNaN(salary) && salary > 0) {
      players.push({ name, salary, team, position });
    }
  }

  if (players.length === 0) {
    throw new Error('No valid player rows with salaries found in CSV.');
  }

  return players;
}

export default function App() {
  const [data, setData] = useState<NbaApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' } | null>(null);
  const [uploadStatus, setUploadStatus] = useState<{ text: string; isError: boolean } | null>(null);

  // Persistent FanDuel uploaded salaries state
  const [fdSalariesMap, setFdSalariesMap] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem('nba_fd_salaries_cache');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.salaries || {};
      }
    } catch (e) {}
    return {};
  });

  const [fdUploadInfo, setFdUploadInfo] = useState<{ timestamp: string; matchedCount: number; unmatchedNames: string[] } | null>(() => {
    try {
      const saved = localStorage.getItem('nba_fd_salaries_cache');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.timestamp) {
          return {
            timestamp: parsed.timestamp,
            matchedCount: parsed.matchedCount || 0,
            unmatchedNames: parsed.unmatchedNames || []
          };
        }
      }
    } catch (e) {}
    return null;
  });

  // Handle FanDuel CSV upload with error messaging
  const handleFanDuelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadStatus(null);

    const reader = new FileReader();

    reader.onerror = () => {
      setUploadStatus({ text: 'Error reading file from disk.', isError: true });
    };

    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        if (!text) {
          throw new Error('File content is empty.');
        }

        const parsedPlayers = parseFanDuelCSV(text);
        const newMap: Record<string, number> = { ...fdSalariesMap };
        const unmatchedList: string[] = [];
        let matched = 0;

        const currentActiveNames = new Set((data?.hotPlayers || []).map(p => normalizePlayerName(p.name)));

        parsedPlayers.forEach(p => {
          const normKey = normalizePlayerName(p.name);
          newMap[normKey] = p.salary;

          if (currentActiveNames.has(normKey)) {
            matched++;
          } else {
            unmatchedList.push(p.name);
          }
        });

        const totalLoaded = parsedPlayers.length;
        const unmatchedCount = totalLoaded - matched;

        const uploadMetadata = {
          salaries: newMap,
          timestamp: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', month: 'numeric', day: 'numeric' }),
          matchedCount: matched,
          unmatchedNames: unmatchedList
        };

        setFdSalariesMap(newMap);
        setFdUploadInfo({
          timestamp: uploadMetadata.timestamp,
          matchedCount: matched,
          unmatchedNames: unmatchedList
        });

        setUploadStatus({
          text: `Loaded ${totalLoaded} players (${matched} matched, ${unmatchedCount} unmatched)`,
          isError: false
        });

        try {
          localStorage.setItem('nba_fd_salaries_cache', JSON.stringify(uploadMetadata));
        } catch (err) {}
      } catch (err: any) {
        console.error('FanDuel CSV upload error:', err);
        setUploadStatus({
          text: err.message || 'Failed to parse FanDuel CSV.',
          isError: true
        });
      } finally {
        e.target.value = '';
      }
    };

    reader.readAsText(file);
  };

  // Merge uploaded FanDuel salaries with current players
  const processedHotPlayers = useMemo(() => {
    if (!data?.hotPlayers) return [];
    return data.hotPlayers.map(p => {
      const norm = normalizePlayerName(p.name);
      const fdSalary = fdSalariesMap[norm] ?? p.fdSalary;
      return {
        ...p,
        fdSalary
      };
    });
  }, [data?.hotPlayers, fdSalariesMap]);

  // Recalculate FanDuel Top 20 list from processed salaries
  const displayFdValuePicks = useMemo(() => {
    const picks = processedHotPlayers
      .filter(p => p.fdSalary !== null && p.fdSalary > 0)
      .map(p => ({
        name: p.name,
        team: p.team,
        value: p.avgFp / (p.fdSalary! / 1000),
        reason: p.driverTeammate && p.driverStatusTonight === 'ruled_out'
          ? 'Injury Beneficiary'
          : p.avgFp >= 35
          ? 'Soft Matchup'
          : 'Value Play'
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);

    return picks.length > 0 ? picks : (data?.fdValuePicks || []);
  }, [processedHotPlayers, data?.fdValuePicks]);

  const sortedHotPlayers = useMemo(() => {
    if (!processedHotPlayers.length) return [];
    const sorted = [...processedHotPlayers];
    if (!sortConfig) return sorted;
    return sorted.sort((a, b) => {
        let aVal: any, bVal: any;
        if (sortConfig.key === 'name') { aVal = a.name; bVal = b.name; }
        else if (sortConfig.key === 'team') { aVal = a.team; bVal = b.team; }
        else if (sortConfig.key === 'dkSalary') { aVal = a.dkSalary || 0; bVal = b.dkSalary || 0; }
        else if (sortConfig.key === 'fdSalary') { aVal = a.fdSalary || 0; bVal = b.fdSalary || 0; }
        else if (sortConfig.key === 'dkValue') {
            aVal = a.dkSalary ? (a.avgFp / (a.dkSalary / 1000)) : -1;
            bVal = b.dkSalary ? (b.avgFp / (b.dkSalary / 1000)) : -1;
        }
        else if (sortConfig.key === 'fdValue') {
            aVal = a.fdSalary ? (a.avgFp / (a.fdSalary / 1000)) : -1;
            bVal = b.fdSalary ? (b.avgFp / (b.fdSalary / 1000)) : -1;
        }
        else if (sortConfig.key === 'avgFp') { aVal = a.avgFp; bVal = b.avgFp; }
        else if (sortConfig.key === 'g2') { aVal = a.g2.fp; bVal = b.g2.fp; }
        else return 0;
        
        if (aVal === bVal) return 0;
        if (aVal === -1) return 1;
        if (bVal === -1) return -1;
        
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });
  }, [processedHotPlayers, sortConfig]);

  const formattedLocalDate = useMemo(() => {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  }, []);

  const fetchData = async (isManual = false) => {
    if (isManual) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/nba-data');
      if (!res.ok) throw new Error('Failed to load fresh NBA data.');
      const json: NbaApiResponse = await res.json();
      setData(json);
      setLastUpdated(new Date());
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error loading live NBA data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans antialiased flex flex-col">
      <header className="border-b border-neutral-800 bg-neutral-900/90 sticky top-0 z-20 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-black text-sm tracking-tight text-white uppercase">Projections BB</span>
            <span className="text-neutral-500 text-xs">|</span>
            <span className="text-xs text-neutral-400 font-medium">{formattedLocalDate}</span>
          </div>
          <button onClick={() => fetchData(true)} className="text-xs flex items-center gap-1.5 text-orange-400 hover:text-orange-300 font-medium transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 flex-1 w-full space-y-6">
        {data && (
          <>
            {/* SCHEDULE SECTION */}
            <section className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-bold text-neutral-200 uppercase tracking-wider">Today's NBA Schedule ({formattedLocalDate})</h2>
                <span className="text-[10px] text-neutral-500">Last Updated: {lastUpdated.toLocaleTimeString()}</span>
              </div>
              {data.games && data.games.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                  {data.games.map(g => (
                    <div key={g.id} className="p-2.5 rounded bg-neutral-950 border border-neutral-800 text-[11px]">
                      <div className="font-bold text-white mb-0.5">{g.awayTeam} @ {g.homeTeam}</div>
                      <div className="text-neutral-400">{g.time} ET</div>
                      <div className={`text-[10px] font-bold mt-1 ${g.classification === 'High Scoring' ? 'text-emerald-400' : g.classification === 'Low Scoring' ? 'text-rose-400' : 'text-neutral-500'}`}>
                        {g.classification} (O/U: N/A)
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-neutral-400 text-xs py-3 text-center">Schedule unavailable</div>
              )}
            </section>

            {/* TOP 20 BEST VALUE PICKS */}
            <section className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
              <h2 className="text-xs font-bold text-neutral-200 uppercase tracking-wider mb-4">Top 20 Best Value Picks</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {['DK', 'FD'].map((site) => {
                  const picksList = site === 'DK' ? data.dkValuePicks : displayFdValuePicks;
                  return (
                    <div key={site} className="space-y-2">
                        <h3 className="text-xs font-semibold text-neutral-400">{site} Classic Picks</h3>
                        <div className="bg-neutral-950 rounded border border-neutral-800 overflow-hidden text-[11px]">
                            {picksList.length > 0 ? (
                              picksList.map((p, i) => (
                                <div key={i} className="flex justify-between items-center py-1.5 px-3 border-b border-neutral-800/60 last:border-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-neutral-500 w-4 font-mono">{i+1}</span>
                                        <span className="text-white font-medium">{p.name}</span>
                                        <span className="text-neutral-500 text-[10px]">({p.team})</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-orange-400 font-bold">{p.value.toFixed(2)}x</span>
                                        <span className="text-neutral-500 text-[10px] bg-neutral-900 px-1.5 py-0.5 rounded">{p.reason}</span>
                                    </div>
                                </div>
                              ))
                            ) : (
                              <div className="py-3 text-center text-neutral-500 text-[11px]">
                                Upload FanDuel salaries to populate picks
                              </div>
                            )}
                        </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* INJURY REPORT */}
            <section className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
              <h2 className="text-xs font-bold text-neutral-200 uppercase tracking-wider mb-3">1. Injury & Availability Report</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.availabilityByTeam.map((teamGroup) => (
                  <div key={teamGroup.team} className="bg-neutral-950/70 border border-neutral-800/80 rounded p-3 text-xs">
                    <div className="font-bold text-white text-xs mb-1.5">{teamGroup.team}</div>
                    {teamGroup.players.map((p, idx) => (
                      <div key={idx} className="flex justify-between text-[11px] py-0.5">
                        <span className="text-neutral-300">{p.name}</span>
                        <span className="text-rose-400 font-bold">{p.status}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>

            {/* HOT PLAYERS LIST */}
            <section className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
              <div className="p-4 border-b border-neutral-800 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-bold text-xs uppercase tracking-wider text-neutral-200">
                    2. Hot Players (Last 2 Games Performance)
                  </div>
                  {fdUploadInfo && (
                    <div className="text-[10px] text-neutral-400 mt-0.5">
                      Last uploaded: {fdUploadInfo.timestamp} ({fdUploadInfo.matchedCount} players matched)
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {uploadStatus && (
                    <span className={`text-[11px] font-medium ${uploadStatus.isError ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {uploadStatus.text}
                    </span>
                  )}
                  <label className="cursor-pointer bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium px-3 py-1.5 rounded border border-neutral-700 transition flex items-center gap-1.5 shrink-0">
                    <Upload className="w-3.5 h-3.5 text-orange-400" />
                    <span>Upload FanDuel Salaries</span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={handleFanDuelUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {fdUploadInfo && fdUploadInfo.unmatchedNames && fdUploadInfo.unmatchedNames.length > 0 && (
                <div className="px-4 py-2 bg-neutral-950/80 border-b border-neutral-800 text-[11px] text-neutral-400">
                  <span className="text-amber-400 font-semibold">Unmatched from file ({fdUploadInfo.unmatchedNames.length}): </span>
                  <span>{fdUploadInfo.unmatchedNames.slice(0, 8).join(', ')}{fdUploadInfo.unmatchedNames.length > 8 ? ` (+${fdUploadInfo.unmatchedNames.length - 8} more)` : ''}</span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="bg-neutral-950/60 text-neutral-400 uppercase text-[10px]">
                      {['name', 'team', 'dkSalary', 'dkValue', 'fdSalary', 'fdValue', 'avgFp', 'g2'].map((key) => {
                          const label = key === 'name' ? 'Player' : key === 'team' ? 'Team' : key === 'dkSalary' ? 'DK Salary' : key === 'dkValue' ? 'DK Value' : key === 'fdSalary' ? 'FD Salary' : key === 'fdValue' ? 'FD Value' : key === 'avgFp' ? 'Avg FP' : 'Last 2 Games (FP/Min)';
                          return (
                              <th key={key} className="py-2 px-3 cursor-pointer hover:text-white" onClick={() => {
                                  if (sortConfig?.key === key) {
                                      setSortConfig({ key, direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' });
                                  } else {
                                      setSortConfig({ key, direction: key === 'name' || key === 'team' ? 'asc' : 'desc' });
                                  }
                              }}>
                                  {label} {sortConfig?.key === key ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
                              </th>
                          );
                      })}
                      <th className="py-2 px-3">Surge Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800/60">
                    {sortedHotPlayers.map((p: HotPlayer) => {
                      const dkValue = p.dkSalary ? (p.avgFp / (p.dkSalary / 1000)) : null;
                      const fdValue = p.fdSalary ? (p.avgFp / (p.fdSalary / 1000)) : null;
                      return (
                        <tr key={p.id} className={`${p.targetStatus === 'prime_target' ? 'bg-orange-500/[0.03]' : ''}`}>
                          <td className="py-2.5 px-3">
                            <span className="font-semibold text-white">{p.name}</span>
                            {p.targetStatus === 'prime_target' && <span className="ml-2 text-[10px] text-orange-400 font-bold">PRIME TARGET</span>}
                            {p.targetStatus === 'fade_risk' && <span className="ml-2 text-[10px] text-rose-400 font-bold">FADE RISK</span>}
                          </td>
                          <td className="py-2.5 px-3 text-neutral-400">{p.team}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-neutral-200">{p.dkSalary ? p.dkSalary.toLocaleString() : '-'}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-orange-400 font-bold">{dkValue !== null ? dkValue.toFixed(1) : '-'}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-neutral-200">{p.fdSalary ? p.fdSalary.toLocaleString() : '-'}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-orange-400 font-bold">{fdValue !== null ? fdValue.toFixed(1) : '-'}</td>
                          <td className="py-2.5 px-3 text-right font-bold text-white">{p.avgFp.toFixed(1)}</td>
                          <td className="py-2.5 px-3 text-right font-mono text-neutral-300">
                            {p.g2.fp.toFixed(1)}/{p.g2.min} | {p.g1.fp.toFixed(1)}/{p.g1.min}
                          </td>
                          <td className="py-2.5 px-3 text-neutral-300">{p.surgeReason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
