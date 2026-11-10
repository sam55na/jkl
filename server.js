const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 5000;

// ================================================================
//   Middleware & CORS
// ================================================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('❌ FATAL: DATABASE_URL is not set!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

const ADMIN_ID = 7011476249;
let dbReady = false;

// ================================================================
//   🗄️ إنشاء الجداول
// ================================================================
const TABLE_SCHEMAS = {
    planet_prizes: `
        CREATE TABLE IF NOT EXISTS planet_prizes (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            amount DECIMAL(20,2) NOT NULL DEFAULT 0,
            icon VARCHAR(50) DEFAULT '💎',
            color VARCHAR(50) DEFAULT '#3498db',
            texture_url TEXT,
            size INTEGER DEFAULT 30,
            probability DECIMAL(5,2) NOT NULL DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `,
    planet_games: `
        CREATE TABLE IF NOT EXISTS planet_games (
            id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL,
            status VARCHAR(20) DEFAULT 'lost',
            prize_id INTEGER REFERENCES planet_prizes(id) ON DELETE SET NULL,
            prize_name VARCHAR(255),
            prize_amount DECIMAL(20,2) DEFAULT 0,
            game_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_rewarded BOOLEAN DEFAULT FALSE,
            rewarded_date TIMESTAMP
        )
    `,
    planet_settings: `
        CREATE TABLE IF NOT EXISTS planet_settings (
            id SERIAL PRIMARY KEY,
            setting_key VARCHAR(100) UNIQUE NOT NULL,
            setting_value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `,
    payments_log: `
        CREATE TABLE IF NOT EXISTS payments_log (
            id SERIAL PRIMARY KEY,
            payment_id VARCHAR(100) UNIQUE,
            user_id VARCHAR(50) NOT NULL,
            amount DECIMAL(20,2) NOT NULL DEFAULT 0,
            method VARCHAR(50) NOT NULL,
            method_type VARCHAR(20) DEFAULT 'auto',
            final_amount DECIMAL(20,2) NOT NULL DEFAULT 0,
            status VARCHAR(20) DEFAULT 'completed',
            payment_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `,
    active_sessions: `
        CREATE TABLE IF NOT EXISTS planet_active_sessions (
            user_id BIGINT PRIMARY KEY,
            winning_prize_id INTEGER,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `
};

const DEFAULT_PRIZES = [
    ['الماسة الفضائية', 1000, '💎', '#9b59b6', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg', 40, 10],
    ['النجم الساطع', 500, '🌟', '#f1c40f', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/mars_1k_color.jpg', 35, 20],
    ['كوكب زحل', 200, '🪐', '#e67e22', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/jupiter_2k.jpg', 30, 30],
    ['كوكب الأرض', 100, '🌍', '#2980b9', 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/saturn_2k.jpg', 25, 40]
];

const DEFAULT_SETTINGS = [
    ['spin_interval_hours', '24'], 
    ['is_active', 'true'], 
    ['deposit_required', 'false'], 
    ['deposit_min_amount', '1000'], 
    ['deposit_check_hours', '24'],
    ['bg_image_url', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=2000&auto=format&fit=crop'],
    ['loading_image_url', 'https://via.placeholder.com/200/1a1a2e/FFD700?text=🪐']
];

// ================================================================
//   دوال التهيئة والمساعدات
// ================================================================
async function ensureTables() {
    const client = await pool.connect();
    try {
        console.log('📋 فحص جداول لعبة الكواكب...');
        for (const table of Object.keys(TABLE_SCHEMAS)) {
            await client.query(TABLE_SCHEMAS[table]);
            console.log(`   ✅ ${table}`);
        }

        const pc = await client.query('SELECT COUNT(*) FROM planet_prizes');
        if (parseInt(pc.rows[0].count) === 0) {
            console.log('   ⚠️ إضافة جوائز افتراضية...');
            for (const p of DEFAULT_PRIZES) {
                await client.query(`INSERT INTO planet_prizes (name, amount, icon, color, texture_url, size, probability) VALUES ($1,$2,$3,$4,$5,$6,$7)`, p);
            }
            console.log(`   ✅ ${DEFAULT_PRIZES.length} جائزة`);
        }

        const sc = await client.query('SELECT COUNT(*) FROM planet_settings');
        if (parseInt(sc.rows[0].count) === 0) {
            for (const s of DEFAULT_SETTINGS) {
                await client.query(`INSERT INTO planet_settings (setting_key, setting_value) VALUES ($1,$2)`, s);
            }
            console.log(`   ✅ ${DEFAULT_SETTINGS.length} إعداد`);
        }
        dbReady = true;
        console.log('✅ قاعدة البيانات جاهزة!');
    } catch (err) {
        console.error('❌ خطأ في التهيئة:', err);
        process.exit(1);
    } finally {
        client.release();
    }
}

async function getSetting(key, defaultValue) {
    const r = await pool.query('SELECT setting_value FROM planet_settings WHERE setting_key = $1', [key]);
    return r.rows[0]?.setting_value ?? defaultValue;
}

async function getRealDeposits(userId, checkHours) {
    const result = await pool.query(`
        SELECT COALESCE(SUM(final_amount), 0) as total FROM payments_log
        WHERE user_id = $1 AND status = 'completed'
          AND method_type NOT IN ('card_game', 'wheel_spin', 'planet_game')
          AND payment_time >= NOW() - ($2::int * INTERVAL '1 hour')
    `, [userId, checkHours]);
    return parseFloat(result.rows[0]?.total || 0);
}

function checkAdmin(req, res, next) {
    const adminId = req.body.admin_id || req.query.admin_id;
    if (parseInt(adminId) !== ADMIN_ID) {
        return res.status(403).json({ success: false, error: 'Unauthorized - Admin only' });
    }
    next();
}

// ================================================================
//   🛣️ المسارات (API)
// ================================================================

// حالة الخادم
app.get('/api/status', (req, res) => {
    res.json({ status: 'running', database: { ready: dbReady } });
});

// جلب البيانات للواجهة
app.get('/api/planet/data', async (req, res) => {
    try {
        const prizes = await pool.query('SELECT id, name, amount, icon, color, texture_url, size FROM planet_prizes WHERE is_active = true ORDER BY id ASC');
        const bg = await getSetting('bg_image_url', '');
        const loading = await getSetting('loading_image_url', '');
        res.json({ success: true, prizes: prizes.rows, background: bg, loading_image: loading });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// حالة المستخدم
app.get('/api/planet/status/:user_id', async (req, res) => {
    const { user_id } = req.params;
    try {
        const lastGame = await pool.query(`SELECT game_date FROM planet_games WHERE user_id = $1 ORDER BY game_date DESC LIMIT 1`, [user_id]);
        const interval = parseInt(await getSetting('spin_interval_hours', '24'));
        let can_play = true, remaining_hours = 0;
        
        if (lastGame.rows.length > 0) {
            const hoursDiff = (Date.now() - new Date(lastGame.rows[0].game_date).getTime()) / 3600000;
            if (hoursDiff < interval) {
                can_play = false;
                remaining_hours = Math.ceil(interval - hoursDiff);
            }
        }
        
        const depositReq = await getSetting('deposit_required', 'false');
        let deposit_met = true;
        if (depositReq === 'true') {
            const minAmount = parseFloat(await getSetting('deposit_min_amount', '1000'));
            const checkHours = parseInt(await getSetting('deposit_check_hours', '24'));
            const total = await getRealDeposits(user_id, checkHours);
            deposit_met = total >= minAmount;
            if (!deposit_met) can_play = false;
        }
        res.json({ success: true, can_play, remaining_hours, deposit_met });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ✅ بدء اللعبة (الخوارزمية الصارمة لمنع "حظ أوفر")
app.post('/api/planet/start', async (req, res) => {
    const { user_id } = req.body;
    if (!dbReady) return res.status(503).json({ success: false, error: 'Database not ready' });
    
    try {
        if (await getSetting('is_active', 'true') !== 'true') 
            return res.status(403).json({ success: false, error: 'اللعبة معطلة' });

        if (await getSetting('deposit_required', 'false') === 'true') {
            const minAmount = parseFloat(await getSetting('deposit_min_amount', '1000'));
            const checkHours = parseInt(await getSetting('deposit_check_hours', '24'));
            const total = await getRealDeposits(user_id, checkHours);
            if (total < minAmount) return res.status(403).json({ success: false, error: 'يجب إكمال شرط الإيداع' });
        }

        const interval = parseInt(await getSetting('spin_interval_hours', '24'));
        const lastGame = await pool.query(`SELECT game_date FROM planet_games WHERE user_id = $1 ORDER BY game_date DESC LIMIT 1`, [user_id]);
        if (lastGame.rows.length > 0) {
            const hoursDiff = (Date.now() - new Date(lastGame.rows[0].game_date).getTime()) / 3600000;
            if (hoursDiff < interval) return res.status(429).json({ success: false, error: 'فترة التبريد لم تنته' });
        }

        const prizes = await pool.query('SELECT * FROM planet_prizes WHERE is_active = true');
        if (prizes.rows.length === 0) return res.status(500).json({ success: false, error: 'لا توجد جوائز' });

        const totalProb = prizes.rows.reduce((s, p) => s + parseFloat(p.probability), 0);
        
        let winningPrize = null;
        
        if (totalProb >= 100) {
            const roll = Math.random() * totalProb;
            let cumulative = 0;
            for (const p of prizes.rows) {
                cumulative += parseFloat(p.probability);
                if (roll <= cumulative) { winningPrize = p; break; }
            }
            if (!winningPrize) winningPrize = prizes.rows[prizes.rows.length - 1];
        } else {
            const loseChance = 100 - totalProb;
            const roll = Math.random() * 100;
            
            if (roll < loseChance) {
                winningPrize = null;
            } else {
                let rand = roll - loseChance;
                let cumulative = 0;
                for (const p of prizes.rows) {
                    cumulative += parseFloat(p.probability);
                    if (rand < cumulative) { winningPrize = p; break; }
                }
                if (!winningPrize) winningPrize = prizes.rows[prizes.rows.length - 1];
            }
        }

        await pool.query(`DELETE FROM planet_active_sessions WHERE user_id = $1`, [user_id]);
        
        if (winningPrize) {
            await pool.query(`INSERT INTO planet_active_sessions (user_id, winning_prize_id) VALUES ($1, $2)`, [user_id, winningPrize.id]);
            res.json({ success: true, winning_prize_id: winningPrize.id });
        } else {
            await pool.query(`INSERT INTO planet_active_sessions (user_id, winning_prize_id) VALUES ($1, $2)`, [user_id, 0]);
            res.json({ success: true, winning_prize_id: 0 });
        }

    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// النقر
app.post('/api/planet/click', async (req, res) => {
    const { user_id, prize_id } = req.body;
    try {
        const session = await pool.query(`SELECT winning_prize_id FROM planet_active_sessions WHERE user_id = $1`, [user_id]);
        if (session.rows.length === 0) return res.status(400).json({ success: false, error: 'لا توجد جلسة' });
        
        const realId = session.rows[0].winning_prize_id;
        const isWin = (realId !== 0 && prize_id === realId);

        const p = (await pool.query('SELECT * FROM planet_prizes WHERE id = $1', [prize_id])).rows[0];

        await pool.query(`
            INSERT INTO planet_games (user_id, status, prize_id, prize_name, prize_amount, is_rewarded)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [user_id, isWin ? 'won' : 'lost', isWin ? p.id : null, isWin ? p.name : 'حظ أوفر', isWin ? p.amount : 0, isWin ? false : true]);

        await pool.query(`DELETE FROM planet_active_sessions WHERE user_id = $1`, [user_id]);

        if (isWin) {
            res.json({ success: true, matched: true, prize: { name: p.name, amount: parseFloat(p.amount), icon: p.icon } });
        } else {
            res.json({ success: true, matched: false });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ================================================================
//   🛠️ مسارات لوحة الإدارة
// ================================================================

app.get('/api/planet/admin/settings', checkAdmin, async (req, res) => {
    const r = await pool.query('SELECT * FROM planet_settings');
    const settings = {};
    r.rows.forEach(row => settings[row.setting_key] = row.setting_value);
    res.json({ success: true, settings });
});

app.put('/api/planet/admin/setting', checkAdmin, async (req, res) => {
    const { key, value } = req.body;
    try {
        await pool.query(`
            INSERT INTO planet_settings (setting_key, setting_value, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = CURRENT_TIMESTAMP
        `, [key, value]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/planet/admin/prizes', checkAdmin, async (req, res) => {
    const r = await pool.query('SELECT * FROM planet_prizes ORDER BY id ASC');
    res.json({ success: true, prizes: r.rows });
});

app.post('/api/planet/admin/prizes', checkAdmin, async (req, res) => {
    const { name, amount, probability, color, texture_url } = req.body;
    try {
        const r = await pool.query(`
            INSERT INTO planet_prizes (name, amount, icon, color, texture_url, size, probability, is_active)
            VALUES ($1, $2, '💎', $3, $4, 30, $5, true) RETURNING *
        `, [name, amount, color, texture_url, probability]);
        res.json({ success: true, prize: r.rows[0] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/planet/admin/prizes/:id', checkAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, amount, probability, color, texture_url, is_active } = req.body;
    try {
        await pool.query(`
            UPDATE planet_prizes 
            SET name=$1, amount=$2, probability=$3, color=$4, texture_url=$5, is_active=$6, updated_at=CURRENT_TIMESTAMP
            WHERE id=$7
        `, [name, amount, probability, color, texture_url, is_active, id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/planet/admin/prizes/:id', checkAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM planet_prizes WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ================================================================
//   التشغيل
// ================================================================
async function startServer() {
    console.log('\n🚀 بدء خادم Cosmic Blast 3D...');
    console.log(`📡 Port: ${port}`);
    console.log(`👑 Admin: ${ADMIN_ID}`);
    
    await ensureTables();
    
    app.listen(port, () => {
        console.log(`\n✅ يعمل على ${port}`);
        console.log(`🔗 http://localhost:${port}/api/status\n`);
    });
}

startServer().catch(err => { console.error('❌', err); process.exit(1); });
