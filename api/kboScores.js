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

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    'Referer': 'https://m.sports.naver.com/',
    'Accept': 'application/json',
    'Origin': 'https://m.sports.naver.com',
  };

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
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) throw new Error(`schedule ${r.status}`);
    const data = await r.json();
    return (data?.result?.games || []).filter(g => g.categoryId === 'kbo');
  }

  async function fetchGameDetail(gameId, inning) {
    const inn = inning || 1;
    const url1 = `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=${inn}&isHighlight=false`;
    const url2 = `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=${inn}&isHighlight=false`;
    try {
      const r1 = await fetch(url1, { headers: HEADERS });
      if (r1.ok) {
        const d1 = await r1.json();
        if (d1?.result) return d1.result;
      }
      const r2 = await fetch(url2, { headers: HEADERS });
      if (r2.ok) {
        const d2 = await r2.json();
        return d2?.result || null;
      }
      return null;
    } catch(e) { return null; }
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
        const r = await fetch(url, { headers: HEADERS });
        if (!r.ok) continue;
        const data = await r.json();
        if (!data?.result) continue;
        const res = data.result;
        // 어떤 URL이 유효한 라인업을 줬는지 로깅
        // result가 비어있지 않으면 반환 (hasData 조건 제거 — 구조 파싱은 extractLineupPair에서)
        console.log('[fetchLineup]', url.split('/').slice(-1)[0], '→ keys:', JSON.stringify(Object.keys(res)).slice(0,200));
        if (res && Object.keys(res).length > 0) return res;
      } catch(e) {}
    }
    return null;
  }

  function convertGame(g, detail) {
    const away = mapTeam(g.awayTeamCode) || g.awayTeamName;
    const home = mapTeam(g.homeTeamCode) || g.homeTeamName;
    const sc = g.statusCode || '';
    const status = (sc==='BEFORE'||sc==='READY')?'SCHEDULED': (sc==='STARTED'||sc==='LIVE')?'LIVE': (sc==='RESULT'||sc==='FINAL')?'FINAL':'SCHEDULED';

    const gameData = detail?.game || g;
    const awayInnRaw = gameData.awayTeamScoreByInning || g.awayTeamScoreByInning || [];
    const homeInnRaw = gameData.homeTeamScoreByInning || g.homeTeamScoreByInning || [];

    const awayInnings = Array(9).fill(-1);
    const homeInnings = Array(9).fill(-1);
    awayInnRaw.forEach((s,i)=>{ if(i<9 && s!=='-') awayInnings[i]=Number(s); });
    homeInnRaw.forEach((s,i)=>{ if(i<9 && s!=='-') homeInnings[i]=Number(s); });

    const rawRelays = findTextRelaysRecursive(detail) || [];
    // 각 relay item에 resultText 추가 (textOptions 마지막 항목)
    const textRelaysData = rawRelays.map(item => ({
      ...item,
      resultText: extractResult(item),
    }));

    // currentGameState: detail 직접 → textRelayData → rawRelays 순으로 탐색
    let bestGs = detail?.currentGameState
      || detail?.textRelayData?.currentGameState
      || null;
    if (!bestGs && rawRelays.length) {
      // rawRelays는 시간순이므로 마지막부터 탐색 (가장 최신)
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
      bestGs = {
        ...bestGs,
        ball:   bestGs.ball   ?? bestGs.ballCount   ?? bestGs.balls   ?? 0,
        strike: bestGs.strike ?? bestGs.strikeCount ?? bestGs.strikes ?? 0,
        out:    bestGs.out    ?? bestGs.outCount     ?? bestGs.outs    ?? 0,
        base1:  bestGs.base1  ?? bestGs.runner1      ?? 0,
        base2:  bestGs.base2  ?? bestGs.runner2      ?? 0,
        base3:  bestGs.base3  ?? bestGs.runner3      ?? 0,
        // 투수/타자 이름 정규화 (숫자 ID는 pcode맵으로 이름 변환)
        pitcherName: (()=>{
          const m2 = {};
          const lu2 = detail?.textRelayData || detail;
          [...(lu2?.homeLineup?.batter||[]),...(lu2?.homeLineup?.pitcher||[]),...(lu2?.awayLineup?.batter||[]),...(lu2?.awayLineup?.pitcher||[])].forEach(p=>{if(p.pcode)m2[String(p.pcode)]=p.name||p.playerName||'';});
          return [bestGs.pitcherName, bestGs.currentPitcherName].find(v=>v&&!/^\d+$/.test(String(v)))
            || m2[String(bestGs.pitcher||'')] || '';
        })(),
        batterName: (()=>{
          const m3 = {};
          const lu3 = detail?.textRelayData || detail;
          [...(lu3?.homeLineup?.batter||[]),...(lu3?.homeLineup?.pitcher||[]),...(lu3?.awayLineup?.batter||[]),...(lu3?.awayLineup?.pitcher||[])].forEach(p=>{if(p.pcode)m3[String(p.pcode)]=p.name||p.playerName||'';});
          return [bestGs.batterName, bestGs.currentBatterName].find(v=>v&&!/^\d+$/.test(String(v)))
            || m3[String(bestGs.batter||'')] || '';
        })(),
      };
    }

    // 선발투수: 네이버 lineup API 응답의 다양한 경로 커버
    function extractStarterFromDetail(side) {
      if (!detail) return null;

      // 구조 1: detail.{side}Summary.pitcherName
      const summary = detail[`${side}Summary`];
      if (summary?.pitcherName) return summary.pitcherName;
      if (summary?.name) return summary.name;

      // 구조 2: detail.pitchers 배열에서 starter
      const pitchers = detail.pitchers;
      if (Array.isArray(pitchers)) {
        const p = pitchers.find(p =>
          (p.side === side || p.teamSide === side) &&
          (p.type === 'starter' || p.orderNum === 1 || p.startYn === 'Y')
        );
        if (p?.name) return p.name;
        if (p?.pitcherName) return p.pitcherName;
      }

      // 구조 3: detail.{side}Starters 배열
      const starters = detail[`${side}Starters`];
      if (Array.isArray(starters) && starters.length) {
        return starters[0]?.name || starters[0]?.pitcherName || null;
      }

      // 구조 4: detail.{side}Lineup.pitcher 배열 첫 번째
      const lineup = detail[`${side}Lineup`] || detail[`${side}TeamLineup`];
      if (lineup?.pitcher) {
        const arr = Array.isArray(lineup.pitcher) ? lineup.pitcher : [lineup.pitcher];
        const sp = arr.find(p => p.startYn === 'Y' || p.orderNum === 1 || p.type === 'starter');
        if (sp?.name) return sp.name;
        if (arr[0]?.name) return arr[0].name;
      }

      // 구조 5: game-polling / preview 스타일
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

    // currentGameState에 inningInfo 주입 (프론트에서 초/말 판별용)
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
      awayScore: g.awayTeamScore!=null ? Number(g.awayTeamScore) : null,
      homeScore: g.homeTeamScore!=null ? Number(g.homeTeamScore) : null,
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
        // 다양한 경로 커버: lineUpData, game-polling의 game 객체, 직접 필드
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

    if (gameId && action === 'lineup') {
      const inn = inning || 1;

      // raw 응답에서 homeLineup/awayLineup 추출 — 네이버 API 구조가 엔드포인트마다 다름
      function extractLineupPair(raw) {
        if (!raw) return { home: null, away: null };
        const td = raw.textRelayData || raw;
        const gd = raw.game || {};

        // 경로 1: 직접 homeLineup/awayLineup (game-polling, text-relay)
        let home = td.homeLineup || raw.homeLineup || gd.homeLineup || null;
        let away = td.awayLineup || raw.awayLineup || gd.awayLineup || null;

        // 경로 2: lineUpData 안 (일부 API)
        if (!home || !away) {
          const lu = raw.lineUpData || gd.lineUpData || {};
          if (!home) home = lu.homeLineup || lu.homeTeamLineup || null;
          if (!away) away = lu.awayLineup || lu.awayTeamLineup || null;
        }

        // 경로 3: homeTeamLineup/awayTeamLineup
        if (!home) home = td.homeTeamLineup || raw.homeTeamLineup || gd.homeTeamLineup || null;
        if (!away) away = td.awayTeamLineup || raw.awayTeamLineup || gd.awayTeamLineup || null;

        console.log('[extractLineupPair] homeL:', !!home, 'awayL:', !!away, 'raw keys:', Object.keys(raw).slice(0,10).join(','));
        return { home, away };
      }

      // 1차: /lineup 전용 API (타자 배열 포함)
      const lineupRaw = await fetchLineup(gameId, inn);
      let { home: homeLineup, away: awayLineup } = extractLineupPair(lineupRaw);

      // 2차: 그래도 없으면 game-polling 시도 (LIVE/RESULT)
      if (!homeLineup && !awayLineup) {
        const pollRaw = await fetchGameDetail(gameId, inn);
        const pair = extractLineupPair(pollRaw);
        homeLineup = pair.home;
        awayLineup = pair.away;
      }

      // 타자 배열이 없으면 라인업 미발표
      const hasBatters = (homeLineup?.batter?.length || homeLineup?.batters?.length || 0) > 0
                      || (awayLineup?.batter?.length || awayLineup?.batters?.length || 0) > 0;
      if (!hasBatters) {
        return res.status(404).json({ error: 'Lineup not found' });
      }

      const td = lineupRaw ? (lineupRaw.textRelayData || lineupRaw) : {};
      let gs = td.currentGameState || lineupRaw?.currentGameState || null;

      // pcode → 이름 맵
      const pcodeMap = {};
      const allPlayers = [
        ...(homeLineup?.batter || []), ...(homeLineup?.pitcher || []),
        ...(awayLineup?.batter || []), ...(awayLineup?.pitcher || []),
      ];
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
          pitcherName: resolveName(gs.pitcherName, gs.pitcher),
          batterName:  resolveName(gs.batterName,  gs.batter),
        };
      }

      console.log('[action=lineup] homeB:', homeLineup?.batter?.length, 'awayB:', awayLineup?.batter?.length);

      return res.status(200).json({
        homeLineup,
        awayLineup,
        currentGameState: gs,
        pcodeMap,
        _raw_keys: Object.keys(td).slice(0, 20),
      });
    }

    if (gameId) {
      const m = String(gameId).match(/^(\d{4})(\d{2})(\d{2})/);
      const gameDateDash = m ? `${m[1]}-${m[2]}-${m[3]}` : todayDash;
      const rawGames = await fetchSchedule(gameDateDash);
      const g = rawGames.find(x => String(x.gameId) === String(gameId));
      if (!g) return res.status(404).json({ error: 'Game not found' });
      const detail = await fetchGameDetail(gameId, inning || (g.statusCode==='RESULT' ? 9 : 1));
      return res.status(200).json(convertGame(g, detail));
    }

    const rawGames = await fetchSchedule(todayDash).catch(() => []);

    // LIVE/RESULT 경기는 game-polling으로 이닝 스코어+currentGameState 확보
    // BEFORE 경기는 lineup으로 선발 정보만 확보
    const detailMap = {};
    await Promise.all(rawGames.map(async g => {
      try {
        if (g.statusCode === 'STARTED' || g.statusCode === 'LIVE' || g.statusCode === 'RESULT' || g.statusCode === 'FINAL') {
          const inn = g.statusCode === 'RESULT' ? 9 : 1;
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
