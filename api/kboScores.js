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
  const mapTeam = value => {
    const team = String(value || '').trim();
    if (TEAM_CODE[team]) return TEAM_CODE[team];
    if (/KIA|기아|타이거즈/i.test(team)) return 'KIA';
    if (/(^|\s)KT|위즈/i.test(team)) return 'KT';
    if (/(^|\s)LG|트윈스/i.test(team)) return 'LG';
    if (/SSG|랜더스/i.test(team)) return 'SSG';
    if (/(^|\s)NC|다이노스/i.test(team)) return 'NC';
    if (/두산|베어스/i.test(team)) return '두산';
    if (/롯데|자이언츠/i.test(team)) return '롯데';
    if (/삼성|라이온즈/i.test(team)) return '삼성';
    if (/한화|이글스/i.test(team)) return '한화';
    if (/키움|히어로즈/i.test(team)) return '키움';
    return team;
  };
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

  // ── 병렬 fetch: 유효한 결과를 가장 빨리 반환한 URL 사용 ──
  async function fetchOneValid(url, validateFn) {
    const r = await fetchWithTimeout(url, { headers: HEADERS }, 7000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const result = d?.result;
    if (!result || !validateFn(result)) throw new Error('invalid');
    return result;
  }

  async function fetchGameDetail(gameId, inning) {
    const inn = Math.max(1, inning || 1);

    const urls = [
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=${inn}&isHighlight=false`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=${inn}&isHighlight=false`,
      ...(inn > 1 ? [
        `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=1&isHighlight=false`,
        `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=1&isHighlight=false`,
      ] : []),
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling`,
    ];

    const validate = r => {
      const hasRelays = findTextRelaysRecursive(r)?.length > 0;
      const hasGs = !!(r.currentGameState || r.textRelayData?.currentGameState);
      return hasRelays || hasGs || !!(r.game || r.inningInfo || r.homeLineup);
    };

    // 주요 2개 URL을 병렬로 먼저 시도, 실패 시 나머지 순차 fallback
    try {
      const result = await Promise.any(
        urls.slice(0, 2).map(url => fetchOneValid(url, validate))
      );
      console.log('[fetchGameDetail] parallel OK for', gameId);
      return result;
    } catch {
      // 나머지 URL 순차 fallback
      for (const url of urls.slice(2)) {
        try {
          const result = await fetchOneValid(url, validate);
          console.log('[fetchGameDetail] fallback OK:', url.split('games/')[1]);
          return result;
        } catch(e) {
          console.log('[fetchGameDetail] error:', url.split('games/')[1], e.message);
        }
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
    const validateLineup = r => r && Object.keys(r).length > 0;
    try {
      const result = await Promise.any(
        urls.slice(0, 3).map(url => fetchOneValid(url, validateLineup))
      );
      console.log('[fetchLineup] parallel OK for', gameId);
      return result;
    } catch {
      try {
        const result = await fetchOneValid(urls[3], validateLineup);
        console.log('[fetchLineup] polling fallback OK for', gameId);
        return result;
      } catch { return null; }
    }
  }

  // 타자/투수 기록이 포함된 데이터를 game-polling inning=9 에서 가져옴 (FINAL 전용)
  async function fetchGameRecord(gameId) {
    const urls = [
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/game-polling?inning=9&isHighlight=false`,
      `https://api-gw.sports.naver.com/schedule/games/${gameId}/text-relay?inning=9&isHighlight=false`,
    ];
    const validateRecord = res => {
      const td = res.textRelayData || res;
      const gd = res.game || {};
      const homeL = td.homeLineup || res.homeLineup || gd.homeLineup || null;
      const awayL = td.awayLineup || res.awayLineup || gd.awayLineup || null;
      return (homeL?.batter?.length || 0) + (awayL?.batter?.length || 0) > 0;
    };
    try {
      const result = await Promise.any(
        urls.map(url => fetchOneValid(url, validateRecord))
      );
      console.log('[fetchGameRecord] parallel OK for', gameId);
      return result;
    } catch { return null; }
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

  // 시즌 전체 경기 결과를 모은다 (결과 반영 · 순위 계산 공용).
  // KBO 공식 일정을 우선 사용하고, 전부 실패하면 네이버 일정으로 폴백한다.
  // 반환: { results: [{date, away, home, status:'FINAL'|'CANCELED', awayScore?, homeScore?, cancelReason?, series}], source }
  // series: regular(정규) | pre(시범) | allstar(올스타) | post(포스트시즌)
  async function loadSeasonResults() {
    const year = kst.getUTCFullYear();
    const lastMonth = Math.min(kst.getUTCMonth() + 1, 11);
    const strip = s => String(s || '').replace(/<[^>]*>/g, '').trim();
    const KBO_REASON = { '우천취소': '우천', '폭염취소': '폭염', '그라운드사정': '그라운드 사정' };
    const KBO_HEADERS = {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': 'https://www.koreabaseball.com/Schedule/Schedule.aspx',
      'X-Requested-With': 'XMLHttpRequest',
    };

    async function fetchKboMonth(srIdList, m, series) {
      const body = new URLSearchParams({
        leId: '1', srIdList, seasonId: String(year), gameMonth: pad(m), teamId: '',
      }).toString();
      const r = await fetchWithTimeout(
        'https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList',
        { method: 'POST', headers: KBO_HEADERS, body }, 10000);
      if (!r.ok) throw new Error('kbo ' + r.status);
      const j = JSON.parse((await r.text()).replace(/^﻿/, ''));
      const out = [];
      let date = null;
      for (const row of (j.rows || [])) {
        const cells = row.row || [];
        const dayCell = cells.find(c => c.Class === 'day');
        if (dayCell) {
          const dm = strip(dayCell.Text).match(/(\d\d)\.(\d\d)/);
          if (dm) date = `${year}-${dm[1]}-${dm[2]}`;
        }
        const play = cells.find(c => c.Class === 'play');
        if (!play || !date) continue;
        const spans = [...String(play.Text).matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(x => x[1]);
        if (spans.length < 3) continue;
        const away = spans[0], home = spans[spans.length - 1];
        const mid = spans.slice(1, -1); // 끝난 경기: ['3','vs','1'] / 아직 안 한 경기: ['vs']
        const note = strip(cells[cells.length - 1] && cells[cells.length - 1].Text);
        const relay = cells.find(c => c.Class === 'relay');
        const hasReview = /리뷰|하이라이트/.test(String(relay && relay.Text || ''));
        if (KBO_REASON[note]) {
          out.push({ date, away, home, status: 'CANCELED', cancelReason: KBO_REASON[note], series });
        } else if (mid.length === 3 && /^\d+$/.test(mid[0]) && /^\d+$/.test(mid[2]) && hasReview) {
          out.push({ date, away, home, status: 'FINAL', awayScore: Number(mid[0]), homeScore: Number(mid[2]), series });
        }
      }
      return out;
    }

    async function fetchNaverMonth(m) {
      const from = `${year}-${pad(m)}-01`;
      const to = `${year}-${pad(m)}-${pad(new Date(year, m, 0).getDate())}`;
      const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic%2Cschedule&upperCategoryId=kbaseball&fromDate=${from}&toDate=${to}&size=500`;
      const r = await fetchWithTimeout(url, { headers: HEADERS });
      if (!r.ok) throw new Error('naver ' + r.status);
      const data = await r.json();
      const out = [];
      for (const g of (data?.result?.games || [])) {
        if (g.categoryId !== 'kbo') continue;
        const sc = g.statusCode || '', si = g.statusInfo || '';
        const date = (g.gameDate || '').slice(0, 10);
        const away = mapTeam(g.awayTeamCode) || g.awayTeamName;
        const home = mapTeam(g.homeTeamCode) || g.homeTeamName;
        const canceled = /CANCEL|PPD|RAINOUT|POSTPONE|SUSPEND/i.test(sc) || /취소|우천|연기|PPD|CANCEL/i.test(si);
        if (canceled) {
          const raw = String(g.cancelReasonName || g.cancelReason || si || '');
          const reason = /우천|강우|비/.test(raw) ? '우천' : /폭염|더위|고온/.test(raw) ? '폭염' : /그라운드/.test(raw) ? '그라운드 사정' : raw;
          out.push({ date, away, home, status: 'CANCELED', cancelReason: reason, series: 'regular' });
        } else if ((sc === 'RESULT' || sc === 'FINAL') && g.awayTeamScore != null && g.homeTeamScore != null) {
          out.push({ date, away, home, status: 'FINAL', awayScore: Number(g.awayTeamScore), homeScore: Number(g.homeTeamScore), series: 'regular' });
        }
      }
      return out;
    }

    const dedupe = list => {
      const map = new Map();
      list.forEach(g => map.set(`${g.date}|${g.away}|${g.home}`, g));
      return [...map.values()];
    };

    // 정규시즌(0,9,6) + 3월 시범(1) + 7월 올스타(9) + 10~11월 포스트시즌(3,4,5,7)
    // 포스트시즌은 묶어서 조회하면 우천취소 경기가 빠지므로 시리즈별로 따로 조회한다.
    const kboJobs = [];
    for (let m = 3; m <= lastMonth; m++) {
      kboJobs.push(fetchKboMonth('0,9,6', m, 'regular'));
      if (m === 3) kboJobs.push(fetchKboMonth('1', m, 'pre'));
      if (m === 7) kboJobs.push(fetchKboMonth('9', m, 'allstar'));
      if (m >= 10) ['3', '4', '5', '7'].forEach(sr => kboJobs.push(fetchKboMonth(sr, m, 'post')));
    }
    const kboSettled = await Promise.allSettled(kboJobs);
    let results = dedupe(kboSettled.flatMap(s => s.status === 'fulfilled' ? s.value : []));
    let source = 'kbo';
    const kboFailed = kboSettled.filter(s => s.status === 'rejected').length;

    // KBO 공식이 전부 실패했거나 결과가 비었으면 네이버로 폴백
    if (!results.length || kboFailed === kboJobs.length) {
      const nvJobs = [];
      for (let m = 3; m <= lastMonth; m++) nvJobs.push(fetchNaverMonth(m));
      const nvSettled = await Promise.allSettled(nvJobs);
      const nv = dedupe(nvSettled.flatMap(s => s.status === 'fulfilled' ? s.value : []));
      if (nv.length) { results = nv; source = 'naver'; }
    }
    return { results, source };
  }

  try {
    const gameId = req.query.gameId;
    const inning = req.query.inning ? parseInt(req.query.inning) : null;
    const action = req.query.action || '';

    // ── 경기 리뷰: KBO 공식 경기센터(스코어보드 + 박스스코어) ──
    // ?action=review&date=YYYY-MM-DD&away=KIA&home=두산[&round=WC 1차전]
    // 이닝별 점수, H/E/B, 타자(타순·포지션·이닝별 타석 결과·타수/안타/타점/득점), 투수 기록, 결승타·홈런 등 경기 요약을 돌려준다.
    if (action === 'review') {
      const rDate = String(req.query.date || '');
      const rAway = String(req.query.away || '');
      const rHome = String(req.query.home || '');
      const rRound = String(req.query.round || '').split(' ')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rDate) || !rAway || !rHome) {
        return res.status(400).json({ error: 'date, away, home required' });
      }
      // KBO 시리즈 ID: 1 시범, 9 올스타, 4 와일드카드, 3 준플레이오프, 5 플레이오프, 7 한국시리즈
      const SR_BY_ROUND = { '시범경기': '1', '올스타전': '9', 'WC': '4', '준PO': '3', 'PO': '5', 'KS': '7' };
      const srId = SR_BY_ROUND[rRound] || '0';
      const rYear = rDate.slice(0, 4);
      const stripR = s => String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
      const KBO_H = {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': 'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx',
        'X-Requested-With': 'XMLHttpRequest',
      };
      async function kboWs(method, params) {
        const r = await fetchWithTimeout(`https://www.koreabaseball.com/ws/${method}`,
          { method: 'POST', headers: KBO_H, body: new URLSearchParams(params).toString() }, 10000);
        if (!r.ok) throw new Error(method + ' ' + r.status);
        return JSON.parse((await r.text()).replace(/^﻿/, ''));
      }
      // KBO가 주는 표(JSON 문자열)를 텍스트 2차원 배열로 바꾼다.
      const tbl = s => {
        if (!s) return [];
        const j = typeof s === 'string' ? JSON.parse(s) : s;
        return (j.rows || []).map(r => (r.row || []).map(c => stripR(c.Text)));
      };
      const POS = { '二': '2B', '중': 'CF', '지': 'DH', '좌': 'LF', '三': '3B', '一': '1B', '유': 'SS', '포': 'C', '우': 'RF', '투': 'P' };
      const num = v => { const n = Number(String(v).replace(/[^\d.-]/g, '')); return isFinite(n) ? n : 0; };

      try {
        // 1) 그날 일정에서 gameId 찾기 (올스타·포스트시즌 등 어떤 시리즈든 링크에 gameId가 들어 있음)
        const sched = await kboWs('Schedule.asmx/GetScheduleList', {
          leId: '1', srIdList: srId === '0' ? '0,9,6' : srId, seasonId: rYear, gameMonth: rDate.slice(5, 7), teamId: '',
        });
        let curDate = null, gameId = '';
        for (const row of (sched.rows || [])) {
          const cells = row.row || [];
          const dc = cells.find(c => c.Class === 'day');
          if (dc) { const m = stripR(dc.Text).match(/(\d\d)\.(\d\d)/); if (m) curDate = `${rYear}-${m[1]}-${m[2]}`; }
          const play = cells.find(c => c.Class === 'play');
          if (!play || curDate !== rDate) continue;
          const sp = [...String(play.Text).matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(x => x[1]);
          if (sp.length < 3 || sp[0] !== rAway || sp[sp.length - 1] !== rHome) continue;
          const relay = cells.find(c => c.Class === 'relay');
          const gm = String(relay && relay.Text || '').match(/gameId=([0-9A-Z]+)/);
          if (gm) { gameId = gm[1]; break; }
        }
        if (!gameId) return res.status(200).json({ available: false, reason: 'game not found' });

        // 2) 스코어보드 + 박스스코어
        const p = { leId: '1', srId, seasonId: rYear, gameId };
        const [sb, bx] = await Promise.all([kboWs('Schedule.asmx/GetScoreBoardScroll', p), kboWs('Schedule.asmx/GetBoxScoreScroll', p)]);

        const inn = tbl(sb.table2);   // [원정 이닝들, 홈 이닝들] ('-'는 없는 이닝)
        const rheb = tbl(sb.table3);  // [[R,H,E,B],[R,H,E,B]]
        if (inn.length < 2 || rheb.length < 2 || !(bx.arrHitter || []).length) {
          return res.status(200).json({ available: false, reason: 'no data yet' });
        }
        const toInn = row => row.map(v => (/^\d+$/.test(v) ? Number(v) : -1));

        const parseHitters = obj => {
          const t1 = tbl(obj.table1), t2 = tbl(obj.table2), t3 = tbl(obj.table3);
          return t1.map((r, k) => {
            const pa = (t2[k] || []).map(x => x || '');
            const st = t3[k] || [];
            return {
              order: num(r[0]), name: r[2] || '', pos: POS[r[1]] || '', posRaw: r[1] || '',
              ab: num(st[0]), h: num(st[1]), rbi: num(st[2]), r: num(st[3]), avg: st[4] || '',
              bb: pa.filter(x => /^(4구|고4)/.test(x)).length,
              pa,
            };
          });
        };
        const parsePitchers = obj => {
          const rows = tbl(obj.table);
          return rows.map(r => ({
            name: r[0], role: r[1], result: r[2], inn: r[6] || '0', pc: num(r[8]), hit: num(r[10]),
            hr: num(r[11]), bb: num(r[12]), kk: num(r[13]), r: num(r[14]), er: num(r[15]), era: r[16] || '',
          }));
        };
        const awayP = parsePitchers((bx.arrPitcher || [])[0] || {});
        const homeP = parsePitchers((bx.arrPitcher || [])[1] || {});
        const allP = [...awayP, ...homeP];
        const pitcherBy = res0 => (allP.find(x => x.result === res0) || {}).name || null;

        const out = {
          available: true,
          gameId, srId,
          stadium: sb.S_NM || '', crowd: sb.CROWD_CN || '',
          startTime: sb.START_TM || '', endTime: sb.END_TM || '', useTime: sb.USE_TM || '',
          awayInnings: toInn(inn[0]), homeInnings: toInn(inn[1]),
          away: { r: num(rheb[0][0]), h: num(rheb[0][1]), e: num(rheb[0][2]), b: num(rheb[0][3]) },
          home: { r: num(rheb[1][0]), h: num(rheb[1][1]), e: num(rheb[1][2]), b: num(rheb[1][3]) },
          summary: tbl(bx.tableEtc).filter(r => r[0] && r[1]).map(r => ({ label: r[0], text: r[1] })),
          awayBatters: parseHitters((bx.arrHitter || [])[0] || {}),
          homeBatters: parseHitters((bx.arrHitter || [])[1] || {}),
          awayPitchers: awayP, homePitchers: homeP,
          winPitcher: pitcherBy('승'), losePitcher: pitcherBy('패'), savePitcher: pitcherBy('세'),
        };
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // 끝난 경기의 기록은 거의 바뀌지 않으므로 1시간 캐시
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
        return res.status(200).json(out);
      } catch (e) {
        return res.status(200).json({ available: false, reason: String(e && e.message || e) });
      }
    }

    // ── 시즌 전체 경기 결과 (승패 자동 반영용) ──
    // 끝난 경기(FINAL)와 취소된 경기(CANCELED)만 반환한다. 예정/진행 중 경기는 기존 실시간 조회가 담당.
    if (action === 'results') {
      const { results, source } = await loadSeasonResults();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // 5분 CDN 캐시 (경기 결과는 자주 바뀌지 않음)
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ results, source, count: results.length, updatedAt: new Date().toISOString() });
    }

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
    // ── 순위 액션: 시즌 전체 일정 기반 계산 ──
    if (action === 'standings') {
      // KBO 공식 일정 기반 결과로 계산한다 (네이버는 폴백). 정규시즌 경기만 집계한다.
      const { results, source } = await loadSeasonResults();
      const TEAMS = ['KIA','KT','LG','SSG','NC','두산','롯데','삼성','한화','키움'];
      const stats = {};
      TEAMS.forEach(t => { stats[t] = {w:0,l:0,d:0,results:[]}; });
      const finals = results
        .filter(g => g.status === 'FINAL' && (g.series === 'regular' || source === 'naver'))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      let counted = 0;
      finals.forEach(g => {
        const away = stats[g.away] ? g.away : mapTeam(g.away);
        const home = stats[g.home] ? g.home : mapTeam(g.home);
        const aw = Number(g.awayScore), hw = Number(g.homeScore);
        if (!stats[away] || !stats[home] || isNaN(aw) || isNaN(hw)) return;
        counted++;
        if (aw > hw) {
          stats[away].w++; stats[home].l++;
          stats[away].results.push('W'); stats[home].results.push('L');
        } else if (hw > aw) {
          stats[home].w++; stats[away].l++;
          stats[home].results.push('W'); stats[away].results.push('L');
        } else {
          stats[away].d++; stats[home].d++;
          stats[away].results.push('D'); stats[home].results.push('D');
        }
      });
      // 경기를 하나도 못 가져왔으면 0승 0패 표를 주지 말고 빈 목록을 준다 (클라이언트가 폴백 계산)
      if (!counted) return res.status(200).json({ standings: [], source });
      const rows = TEAMS.map(t => {
        const s = stats[t];
        const dec = s.w + s.l;
        const pctNum = dec > 0 ? s.w / dec : null;
        // 무승부는 연승/연패를 끊지 않으므로 최근 승패 결과만 연속 계산한다.
        const decisions = s.results.filter(result => result !== 'D');
        const streakType = decisions.at(-1) || '';
        let streak = 0;
        for (let i = decisions.length - 1; i >= 0 && decisions[i] === streakType; i--) streak++;
        return {
          team: t, teamCode: t, teamName: TEAM_FULL[t],
          wins: s.w, losses: s.l, draws: s.d,
          pct: pctNum == null ? null : pctNum.toFixed(3), pctNum,
          streak: streak >= 2 ? streak : 0,
          streakType: streak >= 2 ? streakType : '',
        };
      }).sort((a, b) => (b.pctNum ?? -1) - (a.pctNum ?? -1) || b.wins - a.wins);
      // 승률이 같으면 공동 순위
      rows.forEach((r, i) => {
        r.rank = i > 0 && r.pctNum === rows[i - 1].pctNum && r.wins === rows[i - 1].wins ? rows[i - 1].rank : i + 1;
      });
      rows.forEach(r => { delete r.pctNum; });
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ standings: rows, source });
    }

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
          r:   Number(p.r   ?? p.run   ?? p.runs  ?? p.ra ?? p.er ?? p.earnedRun ?? 0),
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

      const sampleP = [...(homePitcherArr||[]),...(awayPitcherArr||[])][0];
      if (sampleP) console.log('[pitcher sample keys]', Object.keys(sampleP).slice(0,20), 'r:', sampleP.r, 'er:', sampleP.er, 'run:', sampleP.run);
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

    // ── KBO 공식 경기 목록(실시간): 이닝·점수·볼카운트·현재 투수/타자 ──
    // 네이버가 막히거나 늦을 때 실시간 상황을 대신 채우는 용도.
    async function fetchKboLive(dateStr) {
      const r = await fetchWithTimeout('https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList', {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer': 'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({ leId: '1', srId: '0,1,3,4,5,7,9', date: dateStr }).toString(),
      }, 8000);
      if (!r.ok) throw new Error('kbo list ' + r.status);
      const j = JSON.parse((await r.text()).replace(/^\uFEFF/, ''));
      const nm = v => String(v == null ? '' : v).trim();
      return (j.game || []).map(k => {
        const canceled = nm(k.CANCEL_SC_ID) !== '' && nm(k.CANCEL_SC_ID) !== '0';
        const st = nm(k.GAME_STATE_SC);
        const status = canceled ? 'CANCELED' : st === '2' ? 'LIVE' : st === '3' ? 'FINAL' : 'SCHEDULED';
        const inn = Number(k.GAME_INN_NO) || 0;
        const half = nm(k.GAME_TB_SC_NM);
        const inningInfo = status === 'LIVE' && inn ? `${inn}회${half}` : null;
        const away = mapTeam(k.AWAY_ID) || nm(k.AWAY_NM);
        const home = mapTeam(k.HOME_ID) || nm(k.HOME_NM);
        const bottom = half === '말';
        const batting = n => (Number(n) > 0 ? 1 : 0);
        const gs = status === 'LIVE' ? {
          ball: Number(k.BALL_CN) || 0, strike: Number(k.STRIKE_CN) || 0, out: Number(k.OUT_CN) || 0,
          base1: batting(k.B1_BAT_ORDER_NO), base2: batting(k.B2_BAT_ORDER_NO), base3: batting(k.B3_BAT_ORDER_NO),
          pitcherName: nm(k.T_P_NM), batterName: nm(k.B_P_NM),
          _inningInfo: inningInfo || '', _source: 'kbo',
        } : null;
        // KBO: T_P=원정팀 선수, B_P=홈팀 선수. 말(홈 공격)이면 투수=T_P·타자=B_P, 초면 반대.
        if (gs && !bottom) { gs.pitcherName = nm(k.B_P_NM); gs.batterName = nm(k.T_P_NM); }
        const p = status === 'LIVE' ? (bottom ? { awayPitcher: nm(k.T_P_NM) } : { homePitcher: nm(k.B_P_NM) }) : {};
        return {
          date: todayDash,
          time: nm(k.G_TM) || null,
          away, home, status,
          awayScore: status === 'SCHEDULED' ? null : Number(k.T_SCORE_CN) || 0,
          homeScore: status === 'SCHEDULED' ? null : Number(k.B_SCORE_CN) || 0,
          awayInnings: [], homeInnings: [],
          inning: inn || null, inningInfo,
          currentGameState: gs,
          stad: nm(k.S_NM) || null,
          awayStarter: nm(k.T_PIT_P_NM) || null,
          homeStarter: nm(k.B_PIT_P_NM) || null,
          cancelReason: canceled ? nm(k.CANCEL_SC_NM) : null,
          ...p,
          _source: 'kbo',
        };
      });
    }

    // ── 오늘 전체 경기 목록 ──
    const rawGames = await fetchSchedule(todayDash).catch(() => []);

    const detailMap = {};
    await Promise.all(rawGames.map(async g => {
      try {
        if (g.statusCode === 'STARTED' || g.statusCode === 'LIVE' || g.statusCode === 'RESULT' || g.statusCode === 'FINAL') {
          const inn = (g.statusCode === 'RESULT' || g.statusCode === 'FINAL') ? 9
            : (g.statusCode === 'STARTED' || g.statusCode === 'LIVE')
              ? (parseInt(String(g.statusInfo || '').match(/(\d+)/)?.[1] || '1'))
              : 1;
          const d = await fetchGameDetail(g.gameId, inn);
          if (d) detailMap[g.gameId] = d;
        } else {
          const lu = await fetchLineup(g.gameId, 1);
          if (lu) detailMap[g.gameId] = lu;
        }
      } catch(e) {}
    }));
    const allGames = rawGames.map(g => convertGame(g, detailMap[g.gameId] || null));

    // 네이버에 없거나 아직 '예정'인데 KBO 공식이 진행 중/종료로 알려주면 KBO 값으로 채운다
    try {
      const kboGames = await fetchKboLive(todayStr);
      kboGames.forEach(k => {
        const cur = allGames.find(a => a.away === k.away && a.home === k.home);
        if (!cur) { allGames.push(k); return; }
        if (cur.status === 'SCHEDULED' && k.status !== 'SCHEDULED') {
          Object.assign(cur, {
            status: k.status, awayScore: k.awayScore, homeScore: k.homeScore,
            inning: k.inning, inningInfo: k.inningInfo, cancelReason: k.cancelReason,
            currentGameState: k.currentGameState,
          });
          if (k.awayPitcher) cur.awayPitcher = k.awayPitcher;
          if (k.homePitcher) cur.homePitcher = k.homePitcher;
        }
      });
    } catch (e) { /* KBO 목록 실패는 무시 */ }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({ games: allGames, date: todayStr });
  } catch(e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(500).json({ error: e.message });
  }
}
