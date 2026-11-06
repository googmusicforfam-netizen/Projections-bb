/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Upload,
  RefreshCw,
  Search,
  Zap,
  TrendingUp,
  ShieldAlert,
  Flame,
  Calendar,
  Sparkles,
  FileSpreadsheet,
  X,
  Filter,
  CheckCircle2,
  Clock,
  ArrowUpDown,
  SlidersHorizontal,
  ChevronDown,
  Info
} from 'lucide-react';

interface Game {
  id: string;
  awayTeam: string;
  homeTeam: string;
  awayScore?: string | null;
  homeScore?: string | null;
  status: string;
  time: string;
}

interface Player {
  id: string;
  name: string;
  team: string;
  opponent: string;
  position: string;
  headshot?: string | null;
  jersey?: string;
  projection: number;
  projectedOwnership: number;
  isGppTarget: boolean;
  matchupRating: 'Great' | 'Good' | 'Tough';
  oppDefense: number;
  mpg: number;
  ppg: number;
  rpg: number;
  apg: number;
  status: string;
  injuryDetail?: string | null;
  dkSalary: number | null;
  fdSalary: number | null;
  dkPos?: string;
  fdPos?: string;
}

interface NbaApiResponse {
  date: string;
  hasGamesTonight: boolean;
  noGamesMessage?: string;
  games: Game[];
  keyInsights: string[];
  allPlayers: Player[];
}

// Normalize player name for fuzzy matching across DraftKings and FanDuel CSVs
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’\-]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '')
    .trim();
}

// Robust CSV Line Parser respecting quotes
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCSVRow(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVRow(lines[i]);
    if (values.length === 0 || (values.length === 1 && !values[0])) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCSVRow(rowStr: string): string[] {
  const values: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < rowStr.length; i++) {
    const c = rowStr[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      values.push(cur.replace(/^["\s]+|["\s]+$/g, ''));
      cur = '';
    } else {
      cur += c;
    }
  }
  values.push(cur.replace(/^["\s]+|["\s]+$/g, ''));
  return values;
}

export default function App() {
  const [data, setData] = useState<NbaApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [positionFilter, setPositionFilter] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'all' | 'gpp' | 'dk_value' | 'fd_value'>('gpp');
  const [sortBy, setSortBy] = useState<'dk_val' | 'fd_val' | 'proj' | 'own' | 'name'>('proj');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  // File Upload states
  const [dkFileName, setDkFileName] = useState<string | null>(null);
  const [fdFileName, setFdFileName] = useState<string | null>(null);
  const [dkSalaries, setDkSalaries] = useState<Map<string, { salary: number; pos: string }>>(new Map());
  const [fdSalaries, setFdSalaries] = useState<Map<string, { salary: number; pos: string }>>(new Map());
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);

  const dkFileInputRef = useRef<HTMLInputElement>(null);
  const fdFileInputRef = useRef<HTMLInputElement>(null);

  // Device local date formatted: "Friday, November 6"
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
      if (!res.ok) throw new Error('Failed to load active NBA rosters and slate.');
      const json: NbaApiResponse = await res.json();
      setData(json);
      setLastRefreshed(new Date());
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

  // Daily auto-refresh & 2-minute live game refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchData(false);
    }, 120000);
    return () => clearInterval(interval);
  }, []);

  // Parse DraftKings Classic CSV
  const handleDkFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const rows = parseCSV(text);
        const map = new Map<string, { salary: number; pos: string }>();

        rows.forEach((row) => {
          // Classic DK columns: Name, Salary, Position / Roster Position
          // Ignore Showdown/single game entries if Game Info has "Showdown" or "CPT"
          const rosterPos = row['Roster Position'] || row['Position'] || '';
          if (rosterPos.includes('CPT') || row['Game Info']?.toLowerCase().includes('showdown')) {
            return;
          }

          const rawName = row['Name'] || row['Player'] || '';
          const rawSalary = row['Salary'];
          if (rawName && rawSalary) {
            const numSal = parseInt(rawSalary.replace(/[^0-9]/g, ''), 10);
            if (!isNaN(numSal)) {
              map.set(normalizeName(rawName), {
                salary: numSal,
                pos: row['Position'] || row['Roster Position'] || 'UTIL'
              });
            }
          }
        });

        setDkSalaries(map);
        setDkFileName(file.name);
        if (sortBy === 'proj') setSortBy('dk_val');
      } catch (err) {
        console.error('Error parsing DraftKings CSV:', err);
      }
    };
    reader.readAsText(file);
  };

  // Parse FanDuel Classic CSV
  const handleFdFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const rows = parseCSV(text);
        const map = new Map<string, { salary: number; pos: string }>();

        rows.forEach((row) => {
          // Classic FD columns: Nickname (or First Name + Last Name), Salary, Position, Tier
          // Ignore Single Game MVP/STAR/PRO if present
          const pos = row['Position'] || row['Roster Position'] || '';
          if (pos.includes('MVP') || pos.includes('STAR') || pos.includes('PRO')) {
            return;
          }

          const rawName =
            row['Nickname'] ||
            (row['First Name'] && row['Last Name'] ? `${row['First Name']} ${row['Last Name']}` : '') ||
            row['Player'] ||
            '';
          const rawSalary = row['Salary'];
          if (rawName && rawSalary) {
            const numSal = parseInt(rawSalary.replace(/[^0-9]/g, ''), 10);
            if (!isNaN(numSal)) {
              map.set(normalizeName(rawName), {
                salary: numSal,
                pos: row['Position'] || 'UTIL'
              });
            }
          }
        });

        setFdSalaries(map);
        setFdFileName(file.name);
      } catch (err) {
        console.error('Error parsing FanDuel CSV:', err);
      }
    };
    reader.readAsText(file);
  };

  // Merge full roster player pool with uploaded salaries
  const enrichedPlayers = useMemo(() => {
    if (!data?.allPlayers) return [];

    return data.allPlayers.map((player) => {
      const norm = normalizeName(player.name);
      const dk = dkSalaries.get(norm);
      const fd = fdSalaries.get(norm);

      const dkSalary = dk ? dk.salary : player.dkSalary;
      const fdSalary = fd ? fd.salary : player.fdSalary;

      // Calculate Value (Points Per $1,000)
      // e.g. 35 FP on $7,000 = 5.0x value
      const dkValue = dkSalary && dkSalary > 0 ? (player.projection / (dkSalary / 1000)) : null;
      const fdValue = fdSalary && fdSalary > 0 ? (player.projection / (fdSalary / 1000)) : null;

      // Tournament GPP Play flag:
      // High value (>= 5.0x) or high upside projection with low ownership (<= 12%)
      const isTournamentGpp =
        (dkValue !== null && dkValue >= 5.0 && player.projectedOwnership <= 15) ||
        (fdValue !== null && fdValue >= 5.0 && player.projectedOwnership <= 15) ||
        (player.isGppTarget);

      return {
        ...player,
        dkSalary,
        fdSalary,
        dkPos: dk?.pos || player.position,
        fdPos: fd?.pos || player.position,
        dkValue,
        fdValue,
        isGppTarget: isTournamentGpp
      };
    });
  }, [data, dkSalaries, fdSalaries]);

  // Filter and sort the entire pool
  const displayedPlayers = useMemo(() => {
    let pool = enrichedPlayers.filter((p) => {
      const matchesSearch =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.team.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.opponent.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesPos =
        positionFilter === 'ALL' ||
        p.position.toUpperCase().includes(positionFilter) ||
        (p.dkPos && p.dkPos.toUpperCase().includes(positionFilter)) ||
        (p.fdPos && p.fdPos.toUpperCase().includes(positionFilter));

      if (!matchesSearch || !matchesPos) return false;

      if (viewMode === 'gpp') {
        return p.isGppTarget;
      }
      if (viewMode === 'dk_value') {
        return p.dkSalary !== null && p.dkSalary > 0;
      }
      if (viewMode === 'fd_value') {
        return p.fdSalary !== null && p.fdSalary > 0;
      }
      return true;
    });

    pool.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'dk_val') {
        const aVal = a.dkValue ?? -1;
        const bVal = b.dkValue ?? -1;
        comparison = bVal - aVal;
      } else if (sortBy === 'fd_val') {
        const aVal = a.fdValue ?? -1;
        const bVal = b.fdValue ?? -1;
        comparison = bVal - aVal;
      } else if (sortBy === 'proj') {
        comparison = b.projection - a.projection;
      } else if (sortBy === 'own') {
        comparison = a.projectedOwnership - b.projectedOwnership; // Low ownership first
      } else if (sortBy === 'name') {
        comparison = a.name.localeCompare(b.name);
      }
      return sortOrder === 'desc' ? comparison : -comparison;
    });

    return pool;
  }, [enrichedPlayers, searchQuery, positionFilter, viewMode, sortBy, sortOrder]);

  const getMatchupBadge = (rating: 'Great' | 'Good' | 'Tough') => {
    switch (rating) {
      case 'Great':
        return (
          <span className="px-2 py-0.5 text-[11px] font-semibold rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            Great
          </span>
        );
      case 'Good':
        return (
          <span className="px-2 py-0.5 text-[11px] font-semibold rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
            Good
          </span>
        );
      case 'Tough':
        return (
          <span className="px-2 py-0.5 text-[11px] font-semibold rounded bg-rose-500/15 text-rose-400 border border-rose-500/30">
            Tough
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Minimal Top Header */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-600 flex items-center justify-center font-black text-white text-sm shadow">
              BB
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-white tracking-tight">Projections BB</h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-orange-400 border border-slate-700">
                  NBA GPP
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium">
                {formattedLocalDate}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Upload Salaries Button */}
            <button
              onClick={() => setShowUploadModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 transition-all text-xs font-semibold text-slate-200 border border-slate-700 shadow-sm"
              title="Upload DraftKings & FanDuel CSVs"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-orange-400" />
              <span>Salaries</span>
              {(dkFileName || fdFileName) && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 ml-0.5 animate-pulse" />
              )}
            </button>

            {/* Manual Refresh Button */}
            <button
              onClick={() => fetchData(true)}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 transition-all text-xs font-semibold text-slate-200 border border-slate-700 shadow-sm disabled:opacity-50"
              title="Refresh rosters & slate"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-orange-400 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </header>

      {/* Tonight's Games Ticker */}
      {data?.games && data.games.length > 0 && (
        <div className="bg-slate-900/40 border-b border-slate-800/60 py-2 px-4 overflow-x-auto">
          <div className="max-w-7xl mx-auto flex items-center gap-3 min-w-max text-xs">
            <span className="text-slate-500 font-semibold text-[11px] uppercase tracking-wider">Tonight's Slate:</span>
            {data.games.map((g, idx) => (
              <div
                key={g.id || idx}
                className="bg-slate-900 border border-slate-800/80 px-2.5 py-1 rounded text-[11px] flex items-center gap-2"
              >
                <span className="text-slate-300 font-medium">
                  {g.awayTeam} @ {g.homeTeam}
                </span>
                <span className="text-orange-400 font-semibold">{g.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-5 flex-1 w-full space-y-5">
        {loading && !data && (
          <div className="flex flex-col items-center justify-center py-24 space-y-3">
            <div className="w-8 h-8 rounded-full border-2 border-orange-500 border-t-transparent animate-spin"></div>
            <p className="text-xs text-slate-400">Loading active rosters, trades, and injury reports...</p>
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-900/60 text-rose-200 flex items-center justify-between gap-4 text-xs">
            <div>
              <span className="font-bold">Error:</span> {error}
            </div>
            <button
              onClick={() => fetchData(true)}
              className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {data && (
          <>
            {/* 1. Key Insights & Rotation Alerts */}
            {data.keyInsights && data.keyInsights.length > 0 && (
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4 text-orange-400" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    Key Insights & Rotation Alerts
                  </h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {data.keyInsights.map((insight, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg bg-slate-950/50 border border-slate-800/80 text-xs text-slate-300 leading-relaxed flex items-start gap-2.5"
                    >
                      <span className="w-4 h-4 rounded bg-orange-500/20 text-orange-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                        {idx + 1}
                      </span>
                      <span>{insight}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 2. Controls & Filtering */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-slate-900/80 border border-slate-800 p-3 rounded-xl">
              {/* View Tabs */}
              <div className="flex items-center gap-1.5 overflow-x-auto text-xs">
                <button
                  onClick={() => {
                    setViewMode('gpp');
                    setSortBy('proj');
                  }}
                  className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition-all ${
                    viewMode === 'gpp'
                      ? 'bg-orange-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" /> GPP Value Plays
                </button>
                <button
                  onClick={() => setViewMode('all')}
                  className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                    viewMode === 'all'
                      ? 'bg-orange-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Full Active Pool ({enrichedPlayers.length})
                </button>
                {dkFileName && (
                  <button
                    onClick={() => {
                      setViewMode('dk_value');
                      setSortBy('dk_val');
                    }}
                    className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                      viewMode === 'dk_value'
                        ? 'bg-orange-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    DraftKings Value
                  </button>
                )}
                {fdFileName && (
                  <button
                    onClick={() => {
                      setViewMode('fd_value');
                      setSortBy('fd_val');
                    }}
                    className={`px-3 py-1.5 rounded-lg font-semibold transition-all ${
                      viewMode === 'fd_value'
                        ? 'bg-orange-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    FanDuel Value
                  </button>
                )}
              </div>

              {/* Search, Position & Sort */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1 sm:w-48">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search player or team..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-orange-500"
                  />
                </div>

                <select
                  value={positionFilter}
                  onChange={(e) => setPositionFilter(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500"
                >
                  <option value="ALL">All Pos</option>
                  <option value="PG">PG</option>
                  <option value="SG">SG</option>
                  <option value="SF">SF</option>
                  <option value="PF">PF</option>
                  <option value="C">C</option>
                </select>

                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500"
                >
                  <option value="proj">Sort: Proj FP</option>
                  <option value="dk_val">Sort: DK Value (Pts/$K)</option>
                  <option value="fd_val">Sort: FD Value (Pts/$K)</option>
                  <option value="own">Sort: Low Ownership</option>
                  <option value="name">Sort: Name</option>
                </select>
              </div>
            </div>

            {/* 3. Full Player Pool / Value Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="py-2.5 px-3">Player</th>
                      <th className="py-2.5 px-3">Pos</th>
                      <th className="py-2.5 px-3">Team / Matchup</th>
                      <th className="py-2.5 px-3">DK Salary</th>
                      <th className="py-2.5 px-3">FD Salary</th>
                      <th className="py-2.5 px-3">Proj FP</th>
                      <th className="py-2.5 px-3">DK Val</th>
                      <th className="py-2.5 px-3">FD Val</th>
                      <th className="py-2.5 px-3">Proj Own%</th>
                      <th className="py-2.5 px-3">Matchup</th>
                      <th className="py-2.5 px-3">GPP Flag</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-medium">
                    {displayedPlayers.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="py-8 text-center text-slate-500">
                          No active players found matching your filters.
                        </td>
                      </tr>
                    ) : (
                      displayedPlayers.map((p) => (
                        <tr
                          key={p.id}
                          className={`hover:bg-slate-800/40 transition-colors ${
                            p.isGppTarget ? 'bg-orange-500/[0.03]' : ''
                          }`}
                        >
                          {/* Name + Status */}
                          <td className="py-2.5 px-3 font-semibold text-white">
                            <div className="flex items-center gap-2">
                              {p.headshot && (
                                <img
                                  src={p.headshot}
                                  alt=""
                                  className="w-6 h-6 rounded-full bg-slate-800 object-cover shrink-0"
                                  onError={(e) => ((e.target as HTMLElement).style.display = 'none')}
                                />
                              )}
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span>{p.name}</span>
                                  {p.status.includes('GTD') && (
                                    <span className="text-[10px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">
                                      GTD
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Position */}
                          <td className="py-2.5 px-3 text-slate-400">
                            {p.position}
                          </td>

                          {/* Team vs Opponent */}
                          <td className="py-2.5 px-3 text-slate-300">
                            <span className="font-semibold text-slate-200">{p.team}</span> vs {p.opponent}
                          </td>

                          {/* DraftKings Salary */}
                          <td className="py-2.5 px-3 font-mono font-semibold text-emerald-400">
                            {p.dkSalary ? `$${p.dkSalary.toLocaleString()}` : (
                              <span className="text-slate-600 font-normal">--</span>
                            )}
                          </td>

                          {/* FanDuel Salary */}
                          <td className="py-2.5 px-3 font-mono font-semibold text-blue-400">
                            {p.fdSalary ? `$${p.fdSalary.toLocaleString()}` : (
                              <span className="text-slate-600 font-normal">--</span>
                            )}
                          </td>

                          {/* Projected FP */}
                          <td className="py-2.5 px-3 font-mono font-bold text-white text-sm">
                            {p.projection.toFixed(1)}
                          </td>

                          {/* DK Value (Pts/$K) */}
                          <td className="py-2.5 px-3 font-mono">
                            {p.dkValue !== null ? (
                              <span
                                className={`font-bold ${
                                  p.dkValue >= 5.5
                                    ? 'text-emerald-400'
                                    : p.dkValue >= 4.5
                                    ? 'text-slate-200'
                                    : 'text-slate-500'
                                }`}
                              >
                                {p.dkValue.toFixed(2)}x
                              </span>
                            ) : (
                              <span className="text-slate-600">--</span>
                            )}
                          </td>

                          {/* FD Value (Pts/$K) */}
                          <td className="py-2.5 px-3 font-mono">
                            {p.fdValue !== null ? (
                              <span
                                className={`font-bold ${
                                  p.fdValue >= 5.5
                                    ? 'text-emerald-400'
                                    : p.fdValue >= 4.5
                                    ? 'text-slate-200'
                                    : 'text-slate-500'
                                }`}
                              >
                                {p.fdValue.toFixed(2)}x
                              </span>
                            ) : (
                              <span className="text-slate-600">--</span>
                            )}
                          </td>

                          {/* Projected Ownership */}
                          <td className="py-2.5 px-3 font-mono">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                p.projectedOwnership <= 7
                                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                  : p.projectedOwnership <= 14
                                  ? 'bg-slate-800 text-slate-300'
                                  : 'bg-rose-500/10 text-rose-400'
                              }`}
                            >
                              {p.projectedOwnership}%
                            </span>
                          </td>

                          {/* Matchup Rating */}
                          <td className="py-2.5 px-3">
                            {getMatchupBadge(p.matchupRating)}
                          </td>

                          {/* Tournament Flag */}
                          <td className="py-2.5 px-3">
                            {p.isGppTarget ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">
                                <Sparkles className="w-3 h-3" /> GPP Play
                              </span>
                            ) : (
                              <span className="text-slate-600 text-[11px]">--</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Salary Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-orange-400" />
                <h3 className="text-sm font-bold text-white">Upload Daily Salary Files</h3>
              </div>
              <button
                onClick={() => setShowUploadModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Upload your daily DraftKings Classic and FanDuel Classic player pool CSV files. Players are automatically matched across both files by name, and salaries appear side-by-side with points-per-dollar value.
            </p>

            <div className="space-y-3">
              {/* DraftKings Upload Box */}
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                    DraftKings Classic CSV
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {dkFileName ? (
                      <span className="text-emerald-300 font-medium">{dkFileName} ({dkSalaries.size} matched)</span>
                    ) : (
                      'DKSalaries.csv (Standard Classic slate)'
                    )}
                  </div>
                </div>
                <div>
                  <input
                    type="file"
                    ref={dkFileInputRef}
                    accept=".csv"
                    onChange={handleDkFileUpload}
                    className="hidden"
                  />
                  <button
                    onClick={() => dkFileInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700"
                  >
                    {dkFileName ? 'Replace' : 'Upload'}
                  </button>
                </div>
              </div>

              {/* FanDuel Upload Box */}
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-blue-400 flex items-center gap-1.5">
                    FanDuel Classic CSV
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {fdFileName ? (
                      <span className="text-blue-300 font-medium">{fdFileName} ({fdSalaries.size} matched)</span>
                    ) : (
                      'FanDuel-NBA-players-list.csv (Standard slate)'
                    )}
                  </div>
                </div>
                <div>
                  <input
                    type="file"
                    ref={fdFileInputRef}
                    accept=".csv"
                    onChange={handleFdFileUpload}
                    className="hidden"
                  />
                  <button
                    onClick={() => fdFileInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700"
                  >
                    {fdFileName ? 'Replace' : 'Upload'}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 text-[11px] text-slate-400 flex items-start gap-2">
              <Info className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
              <span>
                Showdown or single-game contest files are automatically ignored. Bench players and starters alike will have their value calculated based on projected points per $1,000 of salary.
              </span>
            </div>

            <button
              onClick={() => setShowUploadModal(false)}
              className="w-full py-2 bg-orange-600 hover:bg-orange-500 text-white font-semibold rounded-xl text-xs transition-all shadow-md"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Minimal Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 py-3 px-4 mt-auto">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-[11px] text-slate-500">
          <span>Projections BB — NBA GPP Tournament Value Research</span>
          <span>Full Active Rosters & Daily Refresh</span>
        </div>
      </footer>
    </div>
  );
}
