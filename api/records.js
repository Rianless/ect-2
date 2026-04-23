const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API_SECRET = process.env.RECORDS_API_SECRET; // Vercel 환경변수에 추가 필요

// key 유효성 검사: 영문/숫자/밑줄/하이픈/점/콜론만, 200자 이하
function isValidKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.length > 200) return false;
  return /^[\w\-.:]+$/.test(key);
}

// 요청 인증 검사 (선택적 API_SECRET 사용)
function isAuthorized(req) {
  if (!API_SECRET) return true; // 환경변수 미설정 시 패스 (하위 호환)
  const authHeader = req.headers['x-api-secret'] || req.headers['authorization'];
  return authHeader === API_SECRET || authHeader === `Bearer ${API_SECRET}`;
}

async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  if (res.status === 204) return null;
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 쓰기/삭제 요청은 인증 필요
  const isWriteOp = req.method === 'POST' || req.method === 'DELETE';
  if (isWriteOp && !isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, key } = req.query;

  // key 유효성 검사 (getAll 제외)
  if (action !== 'getAll' && !isValidKey(key)) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  try {
    if (action === 'getAll') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const rows = await supabase('GET', 'game_records?select=key,value');
      const result = {};
      (rows || []).forEach(r => { result[r.key] = r.value; });
      return res.status(200).json(result);
    }

    if (action === 'set' && req.method === 'POST') {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      // body 크기 제한 (5MB)
      if (raw.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'Payload too large' });
      }
      let value;
      try { value = JSON.parse(raw); }
      catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

      await supabase('POST', 'game_records', {
        key,
        value,
        updated_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'del' && req.method === 'DELETE') {
      await supabase('DELETE', `game_records?key=eq.${encodeURIComponent(key)}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    console.error('[records] error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
