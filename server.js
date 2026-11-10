const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 5000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ADMIN_ID = 7011476249;
let dbReady = false;

const TABLE_SCHEMAS = {
    planet_prizes: `CREATE TABLE IF NOT EXISTS planet_prizes (id SERIAL PRIMARY KEY, name VARCHAR(255), amount DECIMAL(20,2) DEFAULT 0, icon VARCHAR(50), color VARCHAR(50), texture_url TEXT, size INTEGER, probability DECIMAL(5,2) DEFAULT 0, is_active BOOLEAN DEFAULT TRUE)`,
    planet_games: `CREATE TABLE IF NOT EXISTS planet_games (id SERIAL PRIMARY KEY, user_id BIGINT, status VARCHAR(20), prize_id INTEGER, prize_name VARCHAR(255), prize_amount DECIMAL(20,2), game_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, is_rewarded BOOLEAN DEFAULT FALSE)`,
    planet_settings: `CREATE TABLE IF NOT EXISTS planet_settings (id SERIAL PRIMARY KEY, setting_key VARCHAR(100) UNIQUE, setting_value TEXT)`,
    payments_log: `CREATE TABLE IF NOT EXISTS payments_log (id SERIAL PRIMARY KEY, user_id VARCHAR(50), final_amount DECIMAL(20,2), method_type VARCHAR(20), status VARCHAR(20), payment_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    active_sessions: `CREATE TABLE IF NOT EXISTS planet_active_sessions (user_id BIGINT PRIMARY KEY, winning_prize_id INTEGER, started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
};

async function ensureTables() {
    const client = await pool.connect();
    try {
        for (const table of Object.keys(TABLE_SCHEMAS)) await client.query(TABLE_SCHEMAS[table]);
        const pc = await client.query('SELECT COUNT(*) FROM planet_prizes');
        if (parseInt(pc.rows[0].count) === 0) {
            const d = [
                ['الماسة الفضائية', 1000, '💎', '#9b59b6', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg', 40, 10],
                ['النجم الساطع', 500, '🌟', '#f1c40f', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/mars_1k_color.jpg', 35, 20],
                ['كوكب زحل', 200, '🪐', '#e67e22', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/jupiter_2k.jpg', 30, 30],
                ['كوكب الأرض', 100, '🌍', '#2980b9', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/saturn_2k.jpg', 25, 40]
            ];
            for (const p of d) await client.query(`INSERT INTO planet_prizes (name, amount, icon, color, texture_url, size, probability) VALUES ($1,$2,$3,$4,$5,$6,$7)`, p);
        }
        const sc = await client.query('SELECT COUNT(*) FROM planet_settings');
        if (parseInt(sc.rows[0].count) === 0) {
            const s = [['spin_interval_hours', '24'], ['is_active', 'true'], ['deposit_required', 'false'], ['deposit_min_amount', '1000'], ['deposit_check_hours', '24'], ['bg_image_url', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=2000']];
            for (const x of s) await client.query(`INSERT INTO planet_settings (setting_key, setting_value) VALUES ($1,$2)`, x);
        }
        dbReady = true;
    } finally { client.release(); }
}

async function getSetting(key, def) { const r = await pool.query('SELECT setting_value FROM planet_settings WHERE setting_key = $1', [key]); return r.rows[0]?.setting_value ?? def; }

// جلب البيانات
app.get('/api/planet/data', async (req, res) => {
    try {
        const prizes = await pool.query('SELECT id, name, amount, icon, color, texture_url, size FROM planet_prizes WHERE is_active = true');
        const bg = await getSetting('bg_image_url', '');
        res.json({ success: true, prizes: prizes.rows, background: bg });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// حالة المستخدم
app.get('/api/planet/status/:user_id', async (req, res) => {
    const { user_id } = req.params;
    try {
        const last = await pool.query(`SELECT game_date FROM planet_games WHERE user_id = $1 ORDER BY game_date DESC LIMIT 1`, [user_id]);
        const int = parseInt(await getSetting('spin_interval_hours', '24'));
        let can_play = true, rem = 0;
        if (last.rows.length > 0) {
            const diff = (Date.now() - new Date(last.rows[0].game_date).getTime()) / 3600000;
            if (diff < int) { can_play = false; rem = Math.ceil(int - diff); }
        }
        res.json({ success: true, can_play, remaining_hours: rem, deposit_met: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ✅ بدء اللعبة (الحل الرياضي الصارم)
app.post('/api/planet/start', async (req, res) => {
    const { user_id } = req.body;
    try {
        const prizes = await pool.query('SELECT * FROM planet_prizes WHERE is_active = true');
        if (prizes.rows.length === 0) return res.status(500).json({ success: false, error: 'لا توجد جوائز' });

        const totalProb = prizes.rows.reduce((s, p) => s + parseFloat(p.probability), 0);
        
        let winningPrize = null;
        // إذا كان المجموع 100 أو أكثر، فإن النسبة لكل جائزة هي (احتمالها / المجموع)
        // هذا يعني أنه لا يوجد "حظ أوفر" رياضياً، لأن مجموع النسب سيكون 100%
        const roll = Math.random() * totalProb;
        let cumulative = 0;
        
        for (const p of prizes.rows) {
            cumulative += parseFloat(p.probability);
            if (roll <= cumulative) {
                winningPrize = p;
                break;
            }
        }
        
        if (!winningPrize) winningPrize = prizes.rows[prizes.rows.length - 1];

        await pool.query(`DELETE FROM planet_active_sessions WHERE user_id = $1`, [user_id]);
        await pool.query(`INSERT INTO planet_active_sessions (user_id, winning_prize_id) VALUES ($1, $2)`, [user_id, winningPrize.id]);
        
        res.json({ success: true, winning_prize_id: winningPrize.id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// النقر
app.post('/api/planet/click', async (req, res) => {
    const { user_id, prize_id } = req.body;
    try {
        const sess = await pool.query(`SELECT winning_prize_id FROM planet_active_sessions WHERE user_id = $1`, [user_id]);
        if (sess.rows.length === 0) return res.status(400).json({ success: false, error: 'لا توجد جلسة' });
        
        const isWin = (prize_id === sess.rows[0].winning_prize_id);
        const p = await pool.query('SELECT * FROM planet_prizes WHERE id = $1', [prize_id]);

        await pool.query(`INSERT INTO planet_games (user_id, status, prize_id, prize_name, prize_amount, is_rewarded) VALUES ($1,$2,$3,$4,$5,$6)`, [
            user_id, isWin ? 'won' : 'lost', isWin ? p.rows[0].id : null, isWin ? p.rows[0].name : 'حظ أوفر', isWin ? p.rows[0].amount : 0, isWin ? false : true
        ]);
        await pool.query(`DELETE FROM planet_active_sessions WHERE user_id = $1`, [user_id]);

        res.json({ success: true, matched: isWin, prize: isWin ? p.rows[0] : null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// الإدارة
app.get('/api/planet/admin/prizes', async (req, res) => {
    const r = await pool.query('SELECT * FROM planet_prizes ORDER BY id ASC');
    res.json({ success: true, prizes: r.rows });
});
app.put('/api/planet/admin/prizes/:id', async (req, res) => {
    const { id } = req.params; const { name, amount, probability, color, texture_url } = req.body;
    await pool.query(`UPDATE planet_prizes SET name=$1, amount=$2, probability=$3, color=$4, texture_url=$5 WHERE id=$6`, [name, amount, probability, color, texture_url, id]);
    res.json({ success: true });
});
app.get('/api/planet/admin/settings', async (req, res) => {
    const r = await pool.query('SELECT * FROM planet_settings'); const s = {}; r.rows.forEach(x => s[x.setting_key] = x.setting_value); res.json({ success: true, settings: s });
});
app.put('/api/planet/admin/setting', async (req, res) => {
    const { key, value } = req.body;
    await pool.query(`INSERT INTO planet_settings (setting_key, setting_value) VALUES ($1,$2) ON CONFLICT (setting_key) DO UPDATE SET setting_value=$2`, [key, value]);
    res.json({ success: true });
});

ensureTables().then(() => app.listen(port, () => console.log(`🚀 Server running on ${port}`)));
