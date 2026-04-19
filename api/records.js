const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, key } = req.query;

  try {
    // 전체 조회
    if (action === 'getAll') {
      const rows = await supabase('GET', 'game_records?select=key,value');
      const result = {};
      (rows || []).forEach(r => { result[r.key] = r.value; });
      return res.status(200).json(result);
    }

    // 저장
    if (action === 'set' && req.method === 'POST') {
      const value = req.body;
      await supabase('POST', 'game_records', {
        key,
        value,
        updated_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true });
    }

    // 삭제
    if (action === 'del' && req.method === 'DELETE') {
      await supabase('DELETE', `game_records?key=eq.${encodeURIComponent(key)}`);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
