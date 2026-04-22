export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const pad = n => String(n).padStart(2, '0');
  const requestedDate = String(req?.query?.date || '').trim();
  const isRequestedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = pad(kst.getUTCMonth() + 1);
  const dd = pad(kst.getUTCDate());

  const todayDash = isRequestedDate ? requestedDate : `${yyyy}-${mm}-${dd}`;
  const todayStr  = todayDash.replace(/-/g, '');

  const TEAM_CODE = {
    'HT':'KIA','KT':'KT','LG':'LG','SK':'SSG','NC':'NC',
    'OB':'두산','LT':'롯데','SS':'삼성','HH':'한화','WO':'키움',
  };
  const mapTeam = code => TEAM_CODE[code] || code;
  const TEAM_FULL = {
    'KIA': 'KIA 타이거즈',
    'KT': 'KT 위즈',
    'LG': 'LG 트윈스',
    'SSG': 'SSG 랜더스',
    'NC': 'NC 다이노스',
    '두산': '두산 베어스',
    '롯데': '롯데 자이언츠',
    '삼성': '삼성 라이온즈',
    '한화': '한화 이글스',
    '키움': '키움 히어로즈',
  };
  const HOME_STADIUM = {
    'KIA': '광주 기아챔피언스필드',
    'KT': '수원KT위즈파크',
    'LG': '잠실야구장',
    '두산': '잠실야구장',
    'SSG': '인천 SSG랜더스필드',
    'NC': '창원NC파크',
    '롯데': '사직야구장',
    '삼성': '대구 삼성라이온즈파크',
    '한화': '대전 한화생명볼파크',
    '키움': '고척스카이돔',
  };
  const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

  // ── 헤더: 브라우저 완전 위장 (Naver IP 차단 우회) ──
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 NaverSportsApp',
    'Referer': 'https://m.sports.naver.com/game/center',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': 'https://m.sports.naver.com',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'x-requested-with': 'XMLHttpRequest',
  };

  // fetch with timeout helper
  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...options, signal: controller.signal });
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  // textRelays 배열 재귀 탐색
  function findTextRelaysRecursive(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && (obj[0].title || obj[0].text || obj[0].type != null)) return obj;
      return null;
    }
    if (obj.textRelays) return obj.textRelays;
    if (obj.relays) return obj.relays;
    if (obj.list) return obj.list;
    for (const key in obj) {
      const found = findTextRelaysRecursive(obj[key]);
      if (found) return found;
    }
    return null;
  }

  // textOptions 마지막 항목에서 결과 텍스트 추출
  function extractResult(item) {
    const opts = item.textOptions || [];
    if (!opts.length) return null;
    const last = opts[opts.length - 1];
    return last?.text || last?.title || null;
  }

  async function fetchSchedule(date) {
    const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule%2Cbaseball%2CmanualRelayUrl&upperCategoryId=kbaseball&fromDate=${date}&toDate=${date}&size=500`;
    const r = await fetchWithTimeout(url, { headers: HEADERS });
    if (!r.ok) throw new Error(`schedule ${r.status}`);
    const data = await r.json();
    return (data?.result?.games || []).filter(g => g.categoryId === 'kbo');
  }

  // ── 핵심 수정: relay 엔드포인트 다양화 + 캐싱 ──
  async function fetchGameDetail(gameId, inning) {
    const inn = Math.max(1, inning || 1);

    // 시도할 URL 목록 (우선순위 순)
    const urls = [
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=${inn}&isHighlight=false`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=${inn}&isHighlight=false`,
      // 이닝이 1보다 크면 1이닝도 추가 fallback
      ...(inn > 1 ? [
        `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=1&isHighlight=false`,
        `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=1&isHighlight=false`,
      ] : []),
      // 이닝 없이 시도
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling`,
    ];

    for (const url of urls) {
      try {
        const r = await fetchWithTimeout(url, { headers: HEADERS }, 7000);
        if (!r.ok) {
          console.log('[fetchGameDetail] HTTP', r.status, url.split('games/')[1]);
          continue;
        }
        const d = await r.json();
        const result = d?.result;
        if (!result) continue;

        // textRelays 또는 currentGameState 중 하나라도 있으면 유효한 응답
        const hasRelays = findTextRelaysRecursive(result)?.length > 0;
        const hasGs = !!(result.currentGameState || result.textRelayData?.currentGameState);
        if (hasRelays || hasGs) {
          console.log('[fetchGameDetail] OK:', url.split('games/')[1], 'relays:', hasRelays, 'gs:', hasGs);
          return result;
        }

        // textRelays는 없지만 inningInfo 등 게임 데이터가 있는 경우도 반환
        if (result.game || result.inningInfo || result.homeLineup) {
          console.log('[fetchGameDetail] partial OK:', url.split('games/')[1]);
          return result;
        }
      } catch(e) {
        console.log('[fetchGameDetail] error:', url.split('games/')[1], e.message);
      }
    }
    return null;
  }

  async function fetchLineup(gameId, inning) {
    const inn = inning || 1;
    const urls = [
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/preview`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/starting-lineup`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/lineup`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=${inn}&isHighlight=false`,
    ];
    for (const url of urls) {
      try {
        const r = await fetchWithTimeout(url, { headers: HEADERS }, 7000);
        if (!r.ok) continue;
        const data = await r.json();
        if (!data?.result) continue;
        const res = data.result;
        console.log('[fetchLineup]', url.split('/').slice(-1)[0].split('?')[0], '→ keys:', JSON.stringify(Object.keys(res)).slice(0,200));
        if (res && Object.keys(res).length > 0) return res;
      } catch(e) {}
    }
    return null;
  }

  // 타자/투수 기록이 포함된 데이터를 game-polling inning=9 에서 가져옴 (FINAL 전용)
  async function fetchGameRecord(gameId) {
    const urls = [
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=9&isHighlight=false`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=9&isHighlight=false`,
    ];
    for (const url of urls) {
      try {
        const r = await fetchWithTimeout(url, { headers: HEADERS }, 7000);
        if (!r.ok) continue;
        const data = await r.json();
        const res = data?.result;
        if (!res) continue;
        // 타자 배열 존재 여부 확인
        const td = res.textRelayData || res;
        const gd = res.game || {};
        const homeL = td.homeLineup || res.homeLineup || gd.homeLineup || null;
        const awayL = td.awayLineup || res.awayLineup || gd.awayLineup || null;
        const hasBatters = (homeL?.batter?.length || 0) + (awayL?.batter?.length || 0) > 0;
        if (hasBatters) {
          console.log('[fetchGameRecord] found from:', url.split('games/')[1]);
          // 투수 원본 필드 확인용 로그
          const sampleP = (homeL?.pitcher || homeL?.pitchers || awayL?.pitcher || awayL?.pitchers || [])[0];
          if (sampleP) console.log('[pitcher raw fields]', JSON.stringify(sampleP));
          return res;
        }
      } catch(e) {}
    }
    return null;
  }

  function convertGame(g, detail) {
    const away = mapTeam(g.awayTeamCode) || g.awayTeamName;
    const home = mapTeam(g.homeTeamCode) || g.homeTeamName;
    const sc = g.statusCode || '';
    const si = g.statusInfo || '';

    // 우천취소 감지
    const isCanceled = /^(CANCEL|PPD|RAINOUT|POSTPONE|SUSPENDED|DELAY|CANCELED|CANCELLED)$/i.test(sc)
      || /CANCEL|PPD|취소|우천|연기|POSTPONE|SUSPEND/i.test(sc)
      || /취소|우천|연기|PPD|CANCEL/i.test(si);

    if (sc && !['BEFORE','READY','STARTED','LIVE','RESULT','FINAL'].includes(sc)) {
      console.log(`[KBO] 특수 statusCode: "${sc}" | statusInfo: "${si}" | gameId: ${g.gameId} | isCanceled: ${isCanceled}`);
    }

    const status = isCanceled ? 'CANCELED'
      : (sc==='BEFORE'||sc==='READY') ? 'SCHEDULED'
      : (sc==='STARTED'||sc==='LIVE') ? 'LIVE'
      : (sc==='RESULT'||sc==='FINAL') ? 'FINAL'
      : 'SCHEDULED';

    const gameData = detail?.game || g;
    const awayInnRaw = gameData.awayTeamScoreByInning || g.awayTeamScoreByInning || [];
    const homeInnRaw = gameData.homeTeamScoreByInning || g.homeTeamScoreByInning || [];

    const maxInnCount = Math.max(9, awayInnRaw.length, homeInnRaw.length);
    const awayInnings = Array(maxInnCount).fill(-1);
    const homeInnings = Array(maxInnCount).fill(-1);
    awayInnRaw.forEach((s,i)=>{ if(s!=='-') awayInnings[i]=Number(s); });
    homeInnRaw.forEach((s,i)=>{ if(s!=='-') homeInnings[i]=Number(s); });

    const rawRelays = findTextRelaysRecursive(detail) || [];
    // 각 relay item에 resultText 추가 (textOptions 마지막 항목)
    const textRelaysData = rawRelays.map(item => ({
      ...item,
      resultText: extractResult(item),
    }));

    // ── currentGameState 탐색: 더 많은 경로 커버 ──
    let bestGs = detail?.currentGameState
      || detail?.textRelayData?.currentGameState
      || detail?.game?.currentGameState
      || null;

    if (!bestGs && rawRelays.length) {
      // rawRelays는 시간순이므로 첫 번째부터 탐색 (가장 최신 — 서버에서 역순 정렬)
      for (let ri = 0; ri < rawRelays.length; ri++) {
        const relay = rawRelays[ri];
        if (relay.currentGameState) { bestGs = relay.currentGameState; break; }
        const opts = relay.textOptions || [];
        for (let oi = opts.length - 1; oi >= 0; oi--) {
          if (opts[oi]?.currentGameState) { bestGs = opts[oi].currentGameState; break; }
        }
        if (bestGs) break;
      }
    }

    // bestGs 필드 정규화 (네이버 API는 다양한 필드명 사용)
    if (bestGs) {
      // pcode → 이름 맵 구성 (lineup 데이터 활용)
      const pcodeMapGs = {};
      const lu2 = detail?.textRelayData || detail;
      const allPlayersGs = [
        ...(lu2?.homeLineup?.batter||[]),
        ...(lu2?.homeLineup?.pitcher||[]),
        ...(lu2?.awayLineup?.batter||[]),
        ...(lu2?.awayLineup?.pitcher||[]),
        ...(lu2?.home?.batters||[]),
        ...(lu2?.home?.pitchers||[]),
        ...(lu2?.away?.batters||[]),
        ...(lu2?.away?.pitchers||[]),
      ];
      allPlayersGs.forEach(p => { if(p.pcode) pcodeMapGs[String(p.pcode)] = p.name||p.playerName||''; });

      const resolvePitcherName = () => {
        const direct = [bestGs.pitcherName, bestGs.currentPitcherName]
          .find(v => v && !/^\d+$/.test(String(v)));
        if (direct) return direct;
        return pcodeMapGs[String(bestGs.pitcher||'')] || pcodeMapGs[String(bestGs.pitcherId||'')] || '';
      };
      const resolveBatterName = () => {
        const direct = [bestGs.batterName, bestGs.currentBatterName]
          .find(v => v && !/^\d+$/.test(String(v)));
        if (direct) return direct;
        return pcodeMapGs[String(bestGs.batter||'')] || pcodeMapGs[String(bestGs.batterId||'')] || '';
      };

      bestGs = {
        ...bestGs,
        ball:   bestGs.ball   ?? bestGs.ballCount   ?? bestGs.balls   ?? 0,
        strike: bestGs.strike ?? bestGs.strikeCount ?? bestGs.strikes ?? 0,
        out:    bestGs.out    ?? bestGs.outCount     ?? bestGs.outs    ?? 0,
        base1:  bestGs.base1  ?? bestGs.runner1      ?? 0,
        base2:  bestGs.base2  ?? bestGs.runner2      ?? 0,
        base3:  bestGs.base3  ?? bestGs.runner3      ?? 0,
        pitcherName: resolvePitcherName(),
        batterName:  resolveBatterName(),
      };
    }

    // 선발투수: 네이버 lineup API 응답의 다양한 경로 커버
    function extractStarterFromDetail(side) {
      if (!detail) return null;

      const summary = detail[`${side}Summary`];
      if (summary?.pitcherName) return summary.pitcherName;
      if (summary?.name) return summary.name;

      const pitchers = detail.pitchers;
      if (Array.isArray(pitchers)) {
        const p = pitchers.find(p =>
          (p.side === side || p.teamSide === side) &&
          (p.type === 'starter' || p.orderNum === 1 || p.startYn === 'Y')
        );
        if (p?.name) return p.name;
        if (p?.pitcherName) return p.pitcherName;
      }

      const starters = detail[`${side}Starters`];
      if (Array.isArray(starters) && starters.length) {
        return starters[0]?.name || starters[0]?.pitcherName || null;
      }

      const lineup = detail[`${side}Lineup`] || detail[`${side}TeamLineup`];
      if (lineup?.pitcher) {
        const arr = Array.isArray(lineup.pitcher) ? lineup.pitcher : [lineup.pitcher];
        const sp = arr.find(p => p.startYn === 'Y' || p.orderNum === 1 || p.type === 'starter');
        if (sp?.name) return sp.name;
        if (arr[0]?.name) return arr[0].name;
      }

      const gd = detail.game || detail || {};
      if (side === 'away') {
        return gd.awayStarterName || gd.awayStarter || gd.awayStarterPitcherName ||
               g.awayStarterName || g.awayStarter || g.awayStarterPitcherName || null;
      } else {
        return gd.homeStarterName || gd.homeStarter || gd.homeStarterPitcherName ||
               g.homeStarterName || g.homeStarter || g.homeStarterPitcherName || null;
      }
    }

    const awayStarter = extractStarterFromDetail('away');
    const homeStarter = extractStarterFromDetail('home');

    // currentGameState에 inningInfo 주입
    const enrichedGs = bestGs ? {
      ...bestGs,
      _inningInfo: g.statusInfo || bestGs.inningDisplay || bestGs.inningText || '',
    } : null;

    return {
      gameId: String(g.gameId || ""),
      date: g.gameDate || '',
      time: g.gameDateTime?.split('T')[1]?.slice(0,5) || g.gameTime || g.startTime || g.schedule?.startTime || null,
      away, home,
      status,
      statusCode: sc,
      statusInfo: si || null,
      awayScore: g.awayTeamScore!=null ? Number(g.awayTeamScore)
        : awayInnings.some(x=>x>=0) ? awayInnings.filter(x=>x>=0).reduce((a,b)=>a+b,0) : null,
      homeScore: g.homeTeamScore!=null ? Number(g.homeTeamScore)
        : homeInnings.some(x=>x>=0) ? homeInnings.filter(x=>x>=0).reduce((a,b)=>a+b,0) : null,
      awayInnings, homeInnings,
      inningInfo: g.statusInfo || null,
      currentGameState: enrichedGs,
      textRelays: textRelaysData,
      stad: g.stadium || g.stadiumName || g.stadName || g.place || null,
      awayStarter,
      homeStarter,
      winPitcher: gameData.winPitcherName || g.winPitcherName || null,
      losePitcher: gameData.losePitcherName || g.losePitcherName || null,
      lineup: detail ? (() => {
        const gp = detail.game || {};
        const lu = detail.lineUpData || gp.lineUpData || {};
        const awayL = lu.awayLineup || lu.awayTeamLineup
          || gp.awayLineup || gp.awayTeamLineup
          || detail.awayLineup || detail.awayTeamLineup
          || detail.lineup?.away || {};
        const homeL = lu.homeLineup || lu.homeTeamLineup
          || gp.homeLineup || gp.homeTeamLineup
          || detail.homeLineup || detail.homeTeamLineup
          || detail.lineup?.home || {};
        const awayBatters = awayL.batter || awayL.batters || awayL.batterList || awayL.players || [];
        const homeBatters = homeL.batter || homeL.batters || homeL.batterList || homeL.players || [];
        console.log('[lineup parse] awayB:', awayBatters.length, 'homeB:', homeBatters.length, 'gp keys:', Object.keys(gp).slice(0,10));
        if (!awayBatters.length && !homeBatters.length) return null;
        return {
          away: { batters: awayBatters, pitcher: awayL.pitcher || awayL.pitchers || [] },
          home: { batters: homeBatters, pitcher: homeL.pitcher || homeL.pitchers || [] },
        };
      })() : null,
    };
  }

  try {
    const gameId = req.query.gameId;
    const inning = req.query.inning ? parseInt(req.query.inning) : null;
    const action = req.query.action || '';

    // ── 시즌 성적 액션 ──
    if (action === 'seasonStats') {
      const currentYear = kst.getUTCFullYear();
      const seasonStart = `${currentYear}-03-22`;
      const yesterday = new Date(kst.getTime() - 24 * 60 * 60 * 1000);
      const yy = yesterday.getUTCFullYear();
      const ym = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
      const yd = String(yesterday.getUTCDate()).padStart(2, '0');
      const seasonEnd = `${yy}-${ym}-${yd}`;

      async function fetchRange(from, to) {
        const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule&upperCategoryId=kbaseball&fromDate=${from}&toDate=${to}&size=500`;
        const r = await fetchWithTimeout(url, { headers: HEADERS });
        if (!r.ok) return [];
        const data = await r.json();
        return (data?.result?.games || []).filter(g => g.categoryId === 'kbo');
      }

      const months = [];
      let cur = new Date(`${currentYear}-03-01`);
      const end = new Date(todayDash);
      while (cur <= end) {
        const y = cur.getUTCFullYear();
        const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
        const lastDay = new Date(y, cur.getUTCMonth() + 1, 0).getDate();
        const from = `${y}-${m}-01`;
        const to   = cur.getUTCMonth() === end.getUTCMonth() && y === end.getUTCFullYear()
          ? todayDash
          : `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
        months.push({ from, to });
        cur = new Date(y, cur.getUTCMonth() + 1, 1);
      }

      const results = await Promise.all(months.map(({ from, to }) =>
        fetchRange(from, to).catch(() => [])
      ));
      const allGames = results.flat();

      const kiaGames = allGames.filter(g => {
        const away = mapTeam(g.awayTeamCode);
        const home = mapTeam(g.homeTeamCode);
        const sc = g.statusCode || '';
        const isFinal = sc === 'RESULT' || sc === 'FINAL';
        const gameDate = (g.gameDate || '').slice(0, 10);
        const isToday = gameDate === todayDash;
        return isFinal && !isToday && (away === 'KIA' || home === 'KIA');
      }).sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || ''));

      let wins = 0, losses = 0, draws = 0;
      let streak = 0, streakType = null;

      kiaGames.forEach(g => {
        const isHome = mapTeam(g.homeTeamCode) === 'KIA';
        const rawKs = isHome ? g.homeTeamScore : g.awayTeamScore;
        const rawOs = isHome ? g.awayTeamScore : g.homeTeamScore;
        if (rawKs == null || rawOs == null) return;
        const ks = Number(rawKs);
        const os = Number(rawOs);
        if (isNaN(ks) || isNaN(os)) return;
        if (ks === 0 && os === 0) return;
        let res;
        if (ks > os)      { wins++;   res = 'W'; }
        else if (ks < os) { losses++; res = 'L'; }
        else              { draws++;  res = 'D'; }
        if (res === streakType) streak++;
        else { streakType = res; streak = 1; }
      });

      const total = wins + losses + draws;
      const decisions = wins + losses;
      const pct = decisions > 0
        ? (wins / decisions).toFixed(3).replace(/^0/, '')
        : '.000';

      return res.status(200).json({
        wins, losses, draws, total,
        pct,
        streak,
        streakType,
      });
    }

    // ── action=lineup: 라인업 + currentGameState ──
    if (gameId && action === 'lineup') {
      const inn = inning || 1;

      function extractLineupPair(raw) {
        if (!raw) return { home: null, away: null };
        const td = raw.textRelayData || raw;
        const gd = raw.game || {};

        let home = td.homeLineup || raw.homeLineup || gd.homeLineup || null;
        let away = td.awayLineup || raw.awayLineup || gd.awayLineup || null;

        if (!home || !away) {
          const lu = raw.lineUpData || gd.lineUpData || {};
          if (!home) home = lu.homeLineup || lu.homeTeamLineup || null;
          if (!away) away = lu.awayLineup || lu.awayTeamLineup || null;
        }

        if (!home) home = td.homeTeamLineup || raw.homeTeamLineup || gd.homeTeamLineup || null;
        if (!away) away = td.awayTeamLineup || raw.awayTeamLineup || gd.awayTeamLineup || null;

        console.log('[extractLineupPair] homeL:', !!home, 'awayL:', !!away, 'raw keys:', Object.keys(raw).slice(0,10).join(','));
        return { home, away };
      }

      function parseBatters(arr) {
        if (!arr?.length) return [];
        return arr.map(p => ({
          batOrder: p.batOrder || p.orderNum || p.order || 0,
          name: p.name || p.playerName || '',
          posName: p.posName || p.position || p.pos || '',
          cin: p.cin,
          cout: p.cout,
          pcode: p.pcode || '',
          ab:  Number(p.ab  ?? p.atBat  ?? 0),
          hit: Number(p.hit ?? p.hits   ?? 0),
          rbi: Number(p.rbi ?? p.rbis   ?? 0),
          run: Number(p.run ?? p.runs   ?? 0),
          bb:  Number(p.bb  ?? p.walk   ?? p.walks ?? p.baseOnBalls ?? 0),
        }));
      }

      function parsePitchers(arr) {
        if (!arr?.length) return [];
        
        return arr.map(p => ({
          seqno: p.seqno || p.orderNum || 0,
          name: p.name || p.playerName || '',
          pcode: p.pcode || '',
          inn: p.inn || p.inning || p.innings || '0',
          kk:  Number(p.kk  ?? p.so    ?? p.strikeout ?? 0),
          bb:  Number(p.bb  ?? p.walk  ?? p.walks     ?? 0),
          er:  Number(p.er  ?? p.earnedRun ?? p.earnedRuns ?? 0),
          hit: Number(p.hit ?? p.hits  ?? 0),
          pc:  Number(p.pc  ?? p.ballCount ?? p.pitchCount ?? p.numPitch ?? p.pitches ?? p.np ?? p.numberOfPitches ?? p.pitchThrown ?? p.totalPitches ?? 0),
          sp:  Number(p.sp  ?? p.strikeCount ?? p.strikes ?? p.numStrike ?? p.numberOfStrikes ?? 0),
        }));
      }

      // 1차: /lineup 전용 API
      const lineupRaw = await fetchLineup(gameId, inn);
      let { home: homeLineup, away: awayLineup } = extractLineupPair(lineupRaw);

      // 2차: game-polling 시도
      if (!homeLineup && !awayLineup) {
        const pollRaw = await fetchGameDetail(gameId, inn);
        const pair = extractLineupPair(pollRaw);
        homeLineup = pair.home;
        awayLineup = pair.away;
      }

      // 3차: FINAL 기록용 — inning=9 game-polling
      const isFinalInn = inn >= 9;
      let recordRaw = null;
      if (isFinalInn || !homeLineup) {
        recordRaw = await fetchGameRecord(gameId);
        if (recordRaw) {
          const pair = extractLineupPair(recordRaw);
          const hasStats = arr => (arr?.batter || arr?.batters || []).some(p => p.ab > 0 || p.hit > 0 || p.rbi > 0);
          if (!homeLineup || hasStats(pair.home)) homeLineup = pair.home || homeLineup;
          if (!awayLineup || hasStats(pair.away)) awayLineup = pair.away || awayLineup;
        }
      }

      const hasBatters = (homeLineup?.batter?.length || homeLineup?.batters?.length || 0) > 0
                      || (awayLineup?.batter?.length || awayLineup?.batters?.length || 0) > 0;
      if (!hasBatters) {
        return res.status(404).json({ error: 'Lineup not found' });
      }

      // ── 핵심 수정: currentGameState를 lineup + game-polling + record 전체에서 탐색 ──
      const allRaws = [lineupRaw, recordRaw].filter(Boolean);
      let gs = null;
      for (const raw of allRaws) {
        const td = raw.textRelayData || raw;
        const candidate = td.currentGameState || raw.currentGameState || raw.game?.currentGameState;
        if (candidate) { gs = candidate; break; }
        // textRelays에서도 탐색
        const relays = findTextRelaysRecursive(raw) || [];
        for (const relay of relays) {
          if (relay.currentGameState) { gs = relay.currentGameState; break; }
          const opts = relay.textOptions || [];
          for (let oi = opts.length - 1; oi >= 0; oi--) {
            if (opts[oi]?.currentGameState) { gs = opts[oi].currentGameState; break; }
          }
          if (gs) break;
        }
        if (gs) break;
      }

      // pcode → 이름 맵
      const pcodeMap = {};
      const homeBatterArr = homeLineup?.batter || homeLineup?.batters || [];
      const awayBatterArr = awayLineup?.batter || awayLineup?.batters || [];
      const homePitcherArr = homeLineup?.pitcher || homeLineup?.pitchers || [];
      const awayPitcherArr = awayLineup?.pitcher || awayLineup?.pitchers || [];
      const allPlayers = [...homeBatterArr, ...awayBatterArr, ...homePitcherArr, ...awayPitcherArr];
      allPlayers.forEach(p => { if (p.pcode) pcodeMap[String(p.pcode)] = p.name || p.playerName || ''; });

      if (gs) {
        const isNumId = v => v && /^\d+$/.test(String(v));
        const resolveName = (nameField, idField) => {
          if (nameField && !isNumId(nameField)) return nameField;
          if (idField) { const mapped = pcodeMap[String(idField)]; if (mapped) return mapped; }
          return '';
        };
        gs = {
          ...gs,
          ball:   gs.ball   ?? gs.ballCount   ?? gs.balls   ?? 0,
          strike: gs.strike ?? gs.strikeCount ?? gs.strikes ?? 0,
          out:    gs.out    ?? gs.outCount     ?? gs.outs    ?? 0,
          base1:  gs.base1  ?? gs.runner1      ?? 0,
          base2:  gs.base2  ?? gs.runner2      ?? 0,
          base3:  gs.base3  ?? gs.runner3      ?? 0,
          pitcherName: resolveName(gs.pitcherName, gs.pitcher),
          batterName:  resolveName(gs.batterName,  gs.batter),
        };
      }

      console.log('[action=lineup] homeB:', homeBatterArr.length, 'awayB:', awayBatterArr.length,
        'homeP:', homePitcherArr.length, 'awayP:', awayPitcherArr.length,
        'gs:', !!gs, 'pitcher:', gs?.pitcherName, 'batter:', gs?.batterName);

      return res.status(200).json({
        homeLineup: {
          batter:  parseBatters(homeBatterArr),
          pitcher: parsePitchers(homePitcherArr),
        },
        awayLineup: {
          batter:  parseBatters(awayBatterArr),
          pitcher: parsePitchers(awayPitcherArr),
        },
        currentGameState: gs,
        pcodeMap,
        _raw_keys: Object.keys(lineupRaw || {}).slice(0, 20),
      });
    }

    // ── 단일 경기 relay 조회 (gameId만, action 없음) ──
    if (gameId) {
      const m = String(gameId).match(/^(\d{4})(\d{2})(\d{2})/);
      const gameDateDash = m ? `${m[1]}-${m[2]}-${m[3]}` : todayDash;
      const rawGames = await fetchSchedule(gameDateDash);
      const g = rawGames.find(x => String(x.gameId) === String(gameId));
      if (!g) return res.status(404).json({ error: 'Game not found' });

      // ── 핵심 수정: inning을 실제 현재 이닝으로 전달 ──
      const targetInning = inning
        || (g.statusCode === 'RESULT' || g.statusCode === 'FINAL' ? 9
          : (parseInt(String(g.statusInfo || '').match(/(\d+)/)?.[1] || '1')));
      const detail = await fetchGameDetail(gameId, targetInning);

      // detail이 null인 경우 — 스케줄 기본 정보만이라도 반환 (프론트가 null 처리)
      if (!detail) {
        console.log('[gameId] fetchGameDetail returned null for', gameId, 'inning', targetInning);
        const minimalResult = convertGame(g, null);
        return res.status(200).json(minimalResult);
      }

      return res.status(200).json(convertGame(g, detail));
    }

    // ── 오늘 전체 경기 목록 ──
    const rawGames = await fetchSchedule(todayDash).catch(() => []);

    const detailMap = {};
    await Promise.all(rawGames.map(async g => {
      try {
        if (g.statusCode === 'STARTED' || g.statusCode === 'LIVE' || g.statusCode === 'RESULT' || g.statusCode === 'FINAL') {
          const inn = (g.statusCode === 'RESULT' || g.statusCode === 'FINAL') ? 9 : 1;
          const d = await fetchGameDetail(g.gameId, inn);
          if (d) detailMap[g.gameId] = d;
        } else {
          const lu = await fetchLineup(g.gameId, 1);
          if (lu) detailMap[g.gameId] = lu;
        }
      } catch(e) {}
    }));
    const allGames = rawGames.map(g => convertGame(g, detailMap[g.gameId] || null));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({ games: allGames, date: todayStr });
  } catch(e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(500).json({ error: e.message });
  }
}
