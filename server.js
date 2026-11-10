const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 5001; // منفذ مختلف عن الخادم الرئيسي إن لزم

// ================================================================
//   إعدادات CORS والوسائط
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
    console.error('❌ DATABASE_URL missing!');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10
});

const ADMIN_ID = 7011476249; // ضع معرف الأدمن هنا
let dbReady = false;

// ================================================================
//   🗄️ إنشاء الجداول الخاصة باللعبة
// ================================================================
const TABLE_SCHEMAS = {
    planet_prizes: `
        CREATE TABLE IF NOT EXISTS planet_prizes (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            amount DECIMAL(20,2) NOT NULL DEFAULT 0,
            icon VARCHAR(50) DEFAULT '💎',
            color VARCHAR(50) DEFAULT '#3498db',
            color2 VARCHAR(50) DEFAULT '#85c1e9',
            size INTEGER DEFAULT 30,
            probability DECIMAL(5,2) NOT NULL DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
    `
};

const DEFAULT_PRIZES = [
    { name: 'الماسة الفضائية', amount: 1000, icon: '💎', color: '#9b59b6', color2: '#e0b0ff', size: 42, probability: 10 },
    { name: 'النجم الساطع', amount: 500, icon: '🌟', color: '#f1c40f', color2: '#fffacd', size: 36, probability: 20 },
    { name: 'كوكب زحل', amount: 200, icon: '🪐', color: '#e67e22', color2: '#f5b041', size: 32, probability: 30 },
    { name: 'كوكب الأرض', amount: 100, icon: '🌍', color: '#2980b9', color2: '#85c1e9', size: 28, probability: 40 }
];

const DEFAULT_SETTINGS = [
    { key: 'spin_interval_hours', value: '24' },
    { key: 'is_active', value: 'true' },
    { key: 'deposit_required', value: 'false' },
    { key: 'deposit_min_amount', value: '1000' },
    { key: 'deposit_check_hours', value: '24' },
    { key: 'bg_image_url', value: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?q=80&w=2000&auto=format&fit=crop' }
];

// ================================================================
//   دوال التهيئة والمساعدة
// ================================================================
async function ensureTables() {
    const client = await pool.connect();
    try {
        console.log('📋 فحص جداول لعبة الكواكب...');
        for (const table of Object.keys(TABLE_SCHEMAS)) {
            await client.query(TABLE_SCHEMAS[table]);
            console.log(`   ✅ ${table}`);
        }
        
        const prizesCount = await client.query('SELECT COUNT(*) FROM planet_prizes');
        if (parseInt(prizesCount.rows[0].count) === 0) {
            for (const p of DEFAULT_PRIZES) {
                await client.query(`
                    INSERT INTO planet_prizes (name, amount, icon, color, color2, size, probability)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)
                `, [p.name, p.amount, p.icon, p.color, p.color2, p.size, p.probability]);
            }
            console.log('   ✅ تم إضافة الجوائز الافتراضية');
        }

        const settingsCount = await client.query('SELECT COUNT(*) FROM planet_settings');
        if (parseInt(settingsCount.rows[0].count) === 0) {
            for (const s of DEFAULT_SETTINGS) {
                await client.query(`INSERT INTO planet_settings (setting_key, setting_value) VALUES ($1,$2)`, [s.key, s.value]);
            }
            console.log('   ✅ تم إضافة الإعدادات الافتراضية');
        }
        dbReady = true;
        console.log('✅ قاعدة البيانات جاهزة!');
    } catch (err) {
        console.error('❌ خطأ في التهيئة:', err);
    } finally {
        client.release();
    }
}

async function getSetting(key, defaultValue) {
    const r = await pool.query('SELECT setting_value FROM planet_settings WHERE setting_key = $1', [key]);
    return r.rows[0]?.setting_value ?? defaultValue;
}

// استثناء جوائز الألعاب من الإيداعات
async function getRealDeposits(userId, checkHours) {
    const result = await pool.query(`
        SELECT COALESCE(SUM(final_amount), 0) as total
        FROM payments_log
        WHERE user_id = $1 
          AND status = 'completed'
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
//   🛣️ مسارات واجهة المستخدم (Frontend API)
// ================================================================

// جلب الجوائز والخلفية
app.get('/api/planet/data', async (req, res) => {
    try {
        const prizes = await pool.query('SELECT id, name, amount, icon, color, color2, size FROM planet_prizes WHERE is_active = true ORDER BY id ASC');
        const bg = await getSetting('bg_image_url', '');
        res.json({ success: true, prizes: prizes.rows, background: bg });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// حالة المستخدم
app.get('/api/planet/status/:user_id', async (req, res) => {
    const { user_id } = req.params;
    try {
        const lastGame = await pool.query(`SELECT game_date FROM planet_games WHERE user_id = $1 ORDER BY game_date DESC LIMIT 1`, [user_id]);
        const interval = parseInt(await getSetting('spin_interval_hours', '24'));
        
        let can_play = true;
        let remaining_hours = 0;

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

// بدء اللعبة (تحديد الكوكب الرابح)
app.post('/api/planet/start', async (req, res) => {
    const { user_id } = req.body;
    if (!dbReady) return res.status(503).json({ success: false, error: 'Database not ready' });

    try {
        const isActive = await getSetting('is_active', 'true');
        if (isActive !== 'true') return res.status(403).json({ success: false, error: 'اللعبة معطلة حالياً' });

        // التحقق من شرط الإيداع
        const depositReq = await getSetting('deposit_required', 'false');
        if (depositReq === 'true') {
            const minAmount = parseFloat(await getSetting('deposit_min_amount', '1000'));
            const checkHours = parseInt(await getSetting('deposit_check_hours', '24'));
            const total = await getRealDeposits(user_id, checkHours);
            if (total < minAmount) return res.status(403).json({ success: false, error: 'يجب إكمال شرط الإيداع أولاً' });
        }

        // التحقق من التبريد
        const interval = parseInt(await getSetting('spin_interval_hours', '24'));
        const lastGame = await pool.query(`SELECT game_date FROM planet_games WHERE user_id = $1 ORDER BY game_date DESC LIMIT 1`, [user_id]);
        if (lastGame.rows.length > 0) {
            const hoursDiff = (Date.now() - new Date(lastGame.rows[0].game_date).getTime()) / 3600000;
            if (hoursDiff < interval) return res.status(429).json({ success: false, error: 'فترة التبريد لم تنته بعد' });
        }

        // اختيار الجائزة (Weighted Random)
        const prizes = await pool.query('SELECT * FROM planet_prizes WHERE is_active = true');
        if (prizes.rows.length === 0) return res.status(500).json({ success: false, error: 'لا توجد جوائز' });

        const totalProb = prizes.rows.reduce((s, p) => s + parseFloat(p.probability), 0);
        let rand = Math.random() * totalProb;
        let winningPrize = prizes.rows[0];
        
        for (const p of prizes.rows) {
            if (rand <= parseFloat(p.probability)) { winningPrize = p; break; }
            rand -= parseFloat(p.probability);
        }

        res.json({ 
            success: true, 
            winning_prize_id: winningPrize.id // نرسل الآيدي فقط، الواجهة لا تعرف قيمته
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// تسجيل النتيجة (يتم استدعاؤها عند النقر على الكوكب الصحيح)
app.post('/api/planet/finish', async (req, res) => {
    const { user_id, prize_id } = req.body;
    try {
        const prize = await pool.query('SELECT * FROM planet_prizes WHERE id = $1', [prize_id]);
        if (prize.rows.length === 0) return res.status(404).json({ success: false, error: 'Prize not found' });
        
        const p = prize.rows[0];
        
        // تسجيل الجولة كفائزة
        await pool.query(`
            INSERT INTO planet_games (user_id, status, prize_id, prize_name, prize_amount, is_rewarded)
            VALUES ($1, 'won', $2, $3, $4, FALSE)
        `, [user_id, p.id, p.name, p.amount]);

        res.json({ 
            success: true, 
            prize: {
                name: p.name,
                amount: parseFloat(p.amount),
                icon: p.icon,
                color: p.color
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ================================================================
//   🛠️ مسارات لوحة الإدارة
// ================================================================
app.get('/api/planet/admin/settings', checkAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM planet_settings');
        const settings = {};
        r.rows.forEach(row => settings[row.setting_key] = row.setting_value);
        res.json({ success: true, settings });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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
    try {
        const r = await pool.query('SELECT * FROM planet_prizes ORDER BY id ASC');
        res.json({ success: true, prizes: r.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/planet/admin/prizes/:id', checkAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, amount, icon, color, color2, size, probability, is_active } = req.body;
    try {
        await pool.query(`
            UPDATE planet_prizes 
            SET name = $1, amount = $2, icon = $3, color = $4, color2 = $5, size = $6, probability = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
            WHERE id = $9
        `, [name, amount, icon, color, color2, size, probability, is_active, id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// التشغيل
ensureTables().then(() => {
    app.listen(port, () => console.log(`🚀 Cosmic Blast Server running on port ${port}`));
});
