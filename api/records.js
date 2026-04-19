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
    if (action === 'getAll') {
      const rows = await supabase('GET', 'game_records?select=key,value');
      const result = {};
      (rows || []).forEach(r => { result[r.key] = r.value; });
      return res.status(200).json(result);
    }

    if (action === 'set' && req.method === 'POST') {
      // body를 직접 문자열로 읽어서 파싱
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      const value = JSON.parse(raw);
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
    return res.status(500).json({ error: e.message });
  }
}
