const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. เชื่อมต่อฐานข้อมูล MySQL
// 1. เชื่อมต่อฐานข้อมูล MySQL
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'irac_ref',
  port: process.env.DB_PORT || 3306
});

db.connect(err => {
  if (err) throw err;
  console.log('เชื่อมต่อ MySQL สำเร็จ!');
});

// ==========================================
// ส่วนที่เพิ่มใหม่: ระบบสมัครสมาชิกและล็อกอิน
// ==========================================

// API: สมัครสมาชิก (Register)
app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;
  const sql = "INSERT INTO users (username, password, name) VALUES (?, ?, ?)";
  db.query(sql, [username, password, name], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'ชื่อผู้ใช้นี้มีในระบบแล้ว' });
      return res.status(500).json(err);
    }
    res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });
  });
});

// API: เข้าสู่ระบบ (Login)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const sql = "SELECT id, username, name FROM users WHERE username = ? AND password = ?";
  db.query(sql, [username, password], (err, results) => {
    if (err) return res.status(500).json(err);
    if (results.length === 0) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    res.json({ success: true, user: results[0] });
  });
});

// ==========================================
// API ระบบจัดการศัตรูพืชเดิม
// ==========================================

// API 1: ดึงรายชื่อศัตรูพืชทั้งหมด
app.get('/api/pests', (req, res) => {
  db.query("SELECT pest_id, pest_name FROM pest", (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// API 2: ดึงกลุ่มยา (MoA) และเช็คประวัติ 3 ครั้งล่าสุดว่าต้องล็อกไหม
app.get('/api/moa-groups', (req, res) => {
  const { pest_id, user_id } = req.query;
  const sql = `
    WITH Last3Usages AS (
        SELECT DISTINCT g_id FROM (
            SELECT g_id FROM usage_history 
            WHERE pest_id = ? AND user_id = ? 
            ORDER BY usage_date DESC LIMIT 3
        ) AS recent_history
    ),
    AvailableGroups AS (
        SELECT DISTINCT g.g_id, g.g_name
        FROM ingredient_pest_control ipc
        JOIN active_ingredient ai ON ipc.c_id = ai.c_id
        JOIN irac_moa_group g ON ai.g_id = g.g_id
        WHERE ipc.pest_id = ?
    )
    SELECT ag.g_id, ag.g_name,
      CASE WHEN ag.g_id IN (SELECT g_id FROM Last3Usages) THEN 1 ELSE 0 END AS is_locked
    FROM AvailableGroups ag
    ORDER BY is_locked ASC, ag.g_id ASC;
  `;
  db.query(sql, [pest_id, user_id, pest_id], (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// API 3: ดึงสารสามัญในกลุ่ม MoA ที่เลือก
app.get('/api/active-ingredients', (req, res) => {
  const { pest_id, g_id } = req.query;
  const sql = `
    SELECT ai.c_id, ai.c_name, ipc.recommended_note
    FROM active_ingredient ai
    JOIN ingredient_pest_control ipc ON ai.c_id = ipc.c_id
    WHERE ai.g_id = ? AND ipc.pest_id = ?
  `;
  db.query(sql, [g_id, pest_id], (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// API 4: ดึงยี่ห้อสินค้า
app.get('/api/products', (req, res) => {
  const { c_id } = req.query;
  db.query("SELECT p_id, p_name FROM product_trade WHERE c_id = ?", [c_id], (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// API 5: บันทึกประวัติการใช้งาน
app.post('/api/usage-history', (req, res) => {
  const { user_id, pest_id, g_id, c_id, p_id, usage_date, location_note } = req.body;
  const sql = "INSERT INTO usage_history (user_id, pest_id, g_id, c_id, p_id, usage_date, location_note) VALUES (?, ?, ?, ?, ?, ?, ?)";
  db.query(sql, [user_id, pest_id, g_id, c_id, p_id, usage_date, location_note], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json({ success: true, message: 'บันทึกข้อมูลสำเร็จ', log_id: result.insertId });
  });
});

// API 6: ดึงประวัติการใช้งานทั้งหมด (เพิ่ม user_id เพื่อกรองเฉพาะคนล็อกอิน)
app.get('/api/history', (req, res) => {
  const { user_id } = req.query;
  const sql = `
    SELECT 
      h.log_id, h.usage_date, p.pest_name, g.g_id, g.g_name, 
      ai.c_name AS ai_name, pt.p_name AS product_name, h.location_note
    FROM usage_history h
    JOIN pest p ON h.pest_id = p.pest_id
    JOIN irac_moa_group g ON h.g_id = g.g_id
    JOIN active_ingredient ai ON h.c_id = ai.c_id
    JOIN product_trade pt ON h.p_id = pt.p_id
    WHERE h.user_id = ? 
    ORDER BY h.usage_date DESC, h.log_id DESC
  `;
  db.query(sql, [user_id], (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

// ==========================================
// คำสั่ง app.listen จะอยู่ล่างสุดเสมอ!
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend API รันอยู่ที่ Port ${PORT}`);
});