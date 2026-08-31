require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const { neon } = require("@neondatabase/serverless");

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 5000);
const configuredDatabaseUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
let databaseUrl = configuredDatabaseUrl;
while (databaseUrl?.includes("&amp;")) databaseUrl = databaseUrl.replaceAll("&amp;", "&");
databaseUrl = databaseUrl?.trim().replace(/^['"`]+|['"`]+$/g, "").split("?")[0];
if (!databaseUrl) throw new Error("NEON_DATABASE_URL is required.");
const sql = neon(databaseUrl);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

class NeonSessionStore extends session.Store {
  get(sid, callback) {
    query(
      "SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()",
      [sid]
    )
      .then((result) => callback(null, result.rows[0]?.sess || null))
      .catch(callback);
  }

  set(sid, sess, callback) {
    const maxAge = Number(sess.cookie?.maxAge);
    const expire = new Date(Date.now() + (Number.isFinite(maxAge) ? maxAge : 1000 * 60 * 60 * 24 * 7));
    query(
      `INSERT INTO sessions (sid, sess, expire)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify(sess), expire]
    )
      .then(() => callback())
      .catch(callback);
  }

  destroy(sid, callback) {
    query("DELETE FROM sessions WHERE sid = $1", [sid])
      .then(() => callback())
      .catch(callback);
  }

  touch(sid, sess, callback) {
    const maxAge = Number(sess.cookie?.maxAge);
    const expire = new Date(Date.now() + (Number.isFinite(maxAge) ? maxAge : 1000 * 60 * 60 * 24 * 7));
    query("UPDATE sessions SET expire = $2 WHERE sid = $1", [sid, expire])
      .then(() => callback())
      .catch(callback);
  }
}

app.use(session({
  secret: process.env.SESSION_SECRET || "development-only-session-secret-change-me",
  store: new NeonSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use((req, res, next) => {
  const sensitiveKeys = new Set(["email", "password", "fullName", "phone"]);
  const hasSensitiveQuery = req.method === "GET"
    && Object.keys(req.query).some((key) => sensitiveKeys.has(key));
  if (!hasSensitiveQuery) return next();
  const safeUrl = new URL(req.originalUrl, "http://localhost");
  sensitiveKeys.forEach((key) => safeUrl.searchParams.delete(key));
  return res.redirect(302, `${safeUrl.pathname}${safeUrl.search}${safeUrl.hash}`);
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  }
});

const asyncRoute = (route) => (req, res, next) => Promise.resolve(route(req, res, next)).catch(next);
const clean = (value, max = 5000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const emailOf = (value) => clean(value, 255).toLowerCase();
const isDate = (value) => !Number.isNaN(Date.parse(value));
const isPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
};

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please sign in to continue." });
  req.user = req.session.user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator access required." });
  }
  req.user = req.session.user;
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin" || !req.session.user.isSuperAdmin) {
    return res.status(403).json({ error: "Only the first approved administrator can perform this action." });
  }
  req.user = req.session.user;
  next();
}

function requireMember(req, res, next) {
  if (!req.session.user || req.session.user.role !== "member") {
    return res.status(403).json({ error: "Only member accounts can create playing schedules." });
  }
  req.user = req.session.user;
  next();
}

app.get("/uploads/:filename", requireAuth, asyncRoute(async (req, res) => {
  const fileId = clean(req.params.filename, 100);
  const proof = await query(`
    SELECT f.original_name, f.content_type, encode(f.data, 'base64') AS data_base64
    FROM uploads f
    JOIN payments p ON p.proof_path = $1
    WHERE f.id = $2 AND (p.user_id = $3 OR $4 = TRUE)
    LIMIT 1`, [`/uploads/${fileId}`, fileId, req.user.id, req.user.role === "admin"]);
  if (!proof.rowCount) {
    return res.status(404).json({ error: "Payment proof not found." });
  }
  sendStoredFile(res, proof.rows[0]);
}));

app.get("/court-images/:filename", requireAuth, asyncRoute(async (req, res) => {
  const fileId = clean(req.params.filename, 100);
  const result = await query(`
    SELECT original_name, content_type, encode(data, 'base64') AS data_base64
    FROM uploads WHERE id = $1`, [fileId]);
  if (!result.rowCount) return res.status(404).json({ error: "Court image not found." });
  sendStoredFile(res, result.rows[0]);
}));

async function query(text, params = []) {
  const normalizedText = text.trim().replace(/;\s*$/, "");
  const isReadQuery = /^\s*SELECT\b/i.test(normalizedText);
  const hasReturning = /\bRETURNING\b/i.test(normalizedText);
  const isDataModifyingWith = /^\s*WITH\b/i.test(normalizedText) && /\b(INSERT|UPDATE|DELETE)\b/i.test(normalizedText);
  const shouldWrapReturning = hasReturning && !isDataModifyingWith;
  const statement = isReadQuery
    ? `SELECT COALESCE(json_agg(query_result), '[]'::json) AS rows
       FROM (${normalizedText}) AS query_result`
    : shouldWrapReturning
      ? `WITH query_result AS (${normalizedText})
         SELECT COALESCE(json_agg(query_result), '[]'::json) AS rows
         FROM query_result`
      : normalizedText;
  const result = await sql.query(statement, params);
  const rows = isReadQuery || shouldWrapReturning ? (result[0]?.rows || []) : result;
  return { rows, rowCount: rows.length };
}

function passwordResetTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newUploadId() {
  return crypto.randomBytes(24).toString("hex");
}

async function saveUpload(file, id) {
  await query(`
    INSERT INTO uploads (id, original_name, content_type, data)
    VALUES ($1, $2, $3, decode($4, 'base64'))`,
    [id, clean(file.originalname, 255) || "upload", file.mimetype, file.buffer.toString("base64")]
  );
}

async function deleteUpload(id) {
  await query("DELETE FROM uploads WHERE id = $1", [id]);
}

function sendStoredFile(res, file) {
  res.set("Content-Type", file.content_type || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename="${String(file.original_name || "upload").replace(/["\r\n]/g, "")}"`);
  res.set("Cache-Control", "private, max-age=3600");
  res.send(Buffer.from(file.data_base64, "base64"));
}

function getPasswordResetMailer() {
  const user = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !password) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: password }
  });
}

function appBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const protocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  return `${protocol}://${req.get("host")}`;
}

async function sendPasswordResetEmail(req, email, token) {
  const mailer = getPasswordResetMailer();
  if (!mailer) throw new Error("Gmail password reset delivery is not configured.");
  const resetUrl = `${appBaseUrl(req)}/?token=${encodeURIComponent(token)}`;
  await mailer.sendMail({
    from: `"PickleBalls" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: "Reset your PickleBalls password",
    text: `Use this link to reset your PickleBalls password. It expires in 30 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#10231f;max-width:560px">
      <h2>Reset your PickleBalls password</h2>
      <p>Use the button below to choose a new password. This link expires in 30 minutes.</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:#174e3f;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Reset password</a></p>
      <p style="color:#6c7b76;font-size:13px">If you did not request this, you can ignore this email.</p>
    </div>`
  });
}

async function createNotification(userId, title, message, type = "info") {
  await query(
    "INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, $4)",
    [userId, title, message, type]
  );
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
}

async function removeUserAccount(userId) {
  const uploads = await query(
    `SELECT REPLACE(proof_path, '/uploads/', '') AS id
     FROM payments
     WHERE user_id = $1 AND proof_path LIKE '/uploads/%'`,
    [userId]
  );
  await query("DELETE FROM sessions WHERE sess->'user'->>'id' = $1", [String(userId)]);
  const deleted = await query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
  if (uploads.rows.length) {
    await query("DELETE FROM uploads WHERE id = ANY($1::text[])", [
      uploads.rows.map((upload) => upload.id)
    ]);
  }
  return deleted;
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/club-stats", asyncRoute(async (req, res) => {
  const result = await query("SELECT COUNT(*)::int AS players FROM users");
  res.json({ players: result.rows[0]?.players || 0 });
}));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const fullName = clean(req.body.fullName, 120);
  const phone = clean(req.body.phone, 30);
  if (!email || !email.includes("@") || password.length < 8 || !fullName || !isPhone(phone)) {
    return res.status(400).json({ error: "Enter your name, phone number, valid email, and password of at least 8 characters." });
  }
  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) return res.status(409).json({ error: "An account with that email already exists." });
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO users (email, password_hash, role, is_super_admin, admin_requested, admin_approved)
     VALUES ($1, $2, 'member', FALSE, FALSE, FALSE)
     RETURNING id, email, role, is_super_admin, admin_requested, admin_approved`,
    [email, passwordHash]
  );
  const user = result.rows[0];
  await query("INSERT INTO profiles (user_id, full_name, phone) VALUES ($1, $2, $3)", [user.id, fullName, phone]);
  await createNotification(user.id, "Welcome to PickleBalls", "Your account is ready. Browse the events and find your next match.", "success");
  req.session.user = { id: user.id, email: user.email, role: user.role, fullName, isSuperAdmin: user.is_super_admin, adminRequested: user.admin_requested, adminApproved: user.admin_approved };
  res.status(201).json({ user: req.session.user });
}));

app.post("/api/auth/admin-register", asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const fullName = clean(req.body.fullName, 120);
  if (!email || !email.includes("@") || password.length < 8 || !fullName) {
    return res.status(400).json({ error: "Enter a name, valid email, and password of at least 8 characters." });
  }
  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) return res.status(409).json({ error: "An account with that email already exists." });
  const passwordHash = await bcrypt.hash(password, 12);
  const adminCount = await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND admin_approved = TRUE");
  const firstAdmin = adminCount.rows[0].count === 0;
  const adminRequested = !firstAdmin;
  const result = await query(
    `INSERT INTO users (email, password_hash, role, is_super_admin, admin_requested, admin_approved)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, role, is_super_admin, admin_requested, admin_approved`,
    [email, passwordHash, firstAdmin ? "admin" : "member", firstAdmin, adminRequested, firstAdmin]
  );
  const user = result.rows[0];
  await query("INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)", [user.id, fullName]);
  if (adminRequested) {
    await query(
      `INSERT INTO notifications (user_id, title, message, type)
       SELECT id, $1, $2, 'warning' FROM users WHERE role = 'admin' AND admin_approved = TRUE`,
      ["Admin approval requested", `${fullName} requested administrator access and is waiting for your review.`]
    );
    return res.status(201).json({
      pendingApproval: true,
      message: "Your admin access request was submitted. A super admin must approve it before you can sign in."
    });
  }
  await createNotification(user.id, "You are the super admin", "Your account is the first administrator account and has full approval power.", "success");
  req.session.user = { id: user.id, email: user.email, role: user.role, fullName, isSuperAdmin: user.is_super_admin, adminRequested: user.admin_requested, adminApproved: user.admin_approved };
  res.status(201).json({ user: req.session.user });
}));

async function authenticate(req, res, adminOnly = false) {
  const email = emailOf(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!email || !email.includes("@") || !password) {
    return res.status(400).json({ error: "Enter a valid email and password." });
  }
  const result = await query(
    `SELECT COALESCE((
       SELECT json_build_object(
         'id', u.id,
         'email', u.email,
         'password_hash', u.password_hash,
         'role', u.role,
         'is_super_admin', u.is_super_admin,
         'admin_requested', u.admin_requested,
         'admin_approved', u.admin_approved,
         'full_name', p.full_name
       )
       FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.email = $1
       LIMIT 1
     ), '{}'::json) AS account`,
    [email]
  );
  const account = result.rows[0]?.account;
  const parsedAccount = typeof account === "string" ? JSON.parse(account) : account;
  const user = parsedAccount?.id ? parsedAccount : null;
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (adminOnly && (user.role !== "admin" || !user.admin_approved)) {
    return res.status(403).json({ error: "Approved administrator access is required for the admin panel." });
  }
  if (user.admin_requested && !user.admin_approved) {
    return res.status(403).json({ error: "Your admin account is still waiting for approval from the super admin." });
  }
  if (user.role === "admin" && !user.admin_approved) {
    return res.status(403).json({ error: "This administrator account has not been approved yet." });
  }
  req.session.user = { id: user.id, email: user.email, role: user.role, fullName: user.full_name, isSuperAdmin: user.is_super_admin, adminRequested: user.admin_requested, adminApproved: user.admin_approved };
  res.json({ user: req.session.user });
}

app.post("/api/auth/login", asyncRoute(async (req, res) => authenticate(req, res)));
app.post("/api/auth/admin-login", asyncRoute(async (req, res) => authenticate(req, res, true)));

app.post("/api/auth/forgot-password", asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const genericResponse = {
    message: "If an account exists for that email, a password reset link is on its way."
  };
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Enter a valid email address." });
  if (!getPasswordResetMailer()) {
    return res.status(503).json({ error: "Password reset email is not configured yet." });
  }

  const account = await query("SELECT id, email FROM users WHERE email = $1", [email]);
  if (!account.rowCount) return res.json(genericResponse);

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = passwordResetTokenHash(token);
  await query("DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at <= NOW()", [account.rows[0].id]);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
    [account.rows[0].id, tokenHash]
  );

  try {
    await sendPasswordResetEmail(req, account.rows[0].email, token);
  } catch (error) {
    await query("DELETE FROM password_reset_tokens WHERE token_hash = $1", [tokenHash]);
    console.error("Password reset email failed:", error.message);
    return res.status(503).json({ error: "Password reset email could not be sent right now." });
  }
  res.json(genericResponse);
}));

app.post("/api/auth/reset-password", asyncRoute(async (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!token || password.length < 8) {
    return res.status(400).json({ error: "Use a reset link and a password of at least 8 characters." });
  }

  const consumed = await query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [passwordResetTokenHash(token)]
  );
  if (!consumed.rowCount) return res.status(400).json({ error: "This reset link is invalid or has expired." });

  const userId = consumed.rows[0].user_id;
  const passwordHash = await bcrypt.hash(password, 12);
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
  await query("DELETE FROM sessions WHERE sess->'user'->>'id' = $1", [String(userId)]);
  res.json({ message: "Your password has been reset. You can now sign in." });
}));

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const result = await query(
    `SELECT u.id, u.email, u.role, u.is_super_admin, u.admin_requested, u.admin_approved,
      p.full_name, p.phone, p.city, p.skill_level, p.avatar_color
      FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
    [req.session.user.id]
  );
  if (!result.rowCount) return res.json({ user: null });
  const user = result.rows[0];
  req.session.user = { id: user.id, email: user.email, role: user.role, fullName: user.full_name, isSuperAdmin: user.is_super_admin, adminRequested: user.admin_requested, adminApproved: user.admin_approved };
  res.json({ user });
}));

app.delete("/api/account", requireAuth, asyncRoute(async (req, res) => {
  if (req.user.isSuperAdmin) {
    return res.status(400).json({ error: "The super admin account cannot be deleted. Transfer access first." });
  }
  const deleted = await removeUserAccount(req.user.id);
  if (!deleted.rowCount) return res.status(404).json({ error: "Account not found." });
  await destroySession(req);
  res.json({ ok: true });
}));

app.get("/api/dashboard", requireAuth, asyncRoute(async (req, res) => {
  const [registrations, payments, notifications, nextEvent] = await Promise.all([
    query("SELECT COUNT(*)::int AS count FROM registrations WHERE user_id = $1 AND status <> 'cancelled'", [req.user.id]),
    query("SELECT COUNT(*)::int AS count FROM payments WHERE user_id = $1 AND status = 'verified'", [req.user.id]),
    query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL", [req.user.id]),
     query(`SELECT name, event_date, location, slot_times, status, confirmation_status FROM (
             SELECT e.name, MIN(cs.slot_date)::timestamptz AS event_date, e.location,
                STRING_AGG(TO_CHAR(cs.start_time, 'HH12:MI AM') || ' – ' || TO_CHAR(cs.end_time, 'HH12:MI AM'), CHR(10) ORDER BY cs.start_time) AS slot_times,
               r.status,
               CASE
                 WHEN latest_payment.status = 'verified' THEN 'fully_confirmed'
                 WHEN latest_payment.status = 'pending' THEN 'payment_pending'
                 WHEN r.status = 'confirmed' THEN 'awaiting_payment'
                 ELSE 'pending_approval'
               END AS confirmation_status,
               MIN(cs.start_time) AS start_time
             FROM registrations r
             JOIN events e ON e.id = r.event_id
             JOIN registration_slots rs ON rs.registration_id = r.id
             JOIN court_slots cs ON cs.id = rs.slot_id
              LEFT JOIN LATERAL (
                SELECT p.status FROM payments p
                WHERE p.registration_id = r.id
                ORDER BY p.submitted_at DESC
                LIMIT 1
              ) latest_payment ON TRUE
             WHERE r.user_id = $1 AND r.status <> 'cancelled' AND cs.slot_date >= CURRENT_DATE
              GROUP BY r.id, e.id, e.name, e.location, r.status, latest_payment.status
             UNION ALL
             SELECT e.name, e.event_date, e.location, NULL::text AS slot_times,
                r.status,
                CASE
                  WHEN latest_payment.status = 'verified' THEN 'fully_confirmed'
                  WHEN latest_payment.status = 'pending' THEN 'payment_pending'
                  WHEN r.status = 'confirmed' THEN 'awaiting_payment'
                  ELSE 'pending_approval'
                END AS confirmation_status,
                NULL::time AS start_time
             FROM registrations r
             JOIN events e ON e.id = r.event_id
              LEFT JOIN LATERAL (
                SELECT p.status FROM payments p
                WHERE p.registration_id = r.id
                ORDER BY p.submitted_at DESC
                LIMIT 1
              ) latest_payment ON TRUE
             WHERE r.user_id = $1 AND r.status <> 'cancelled' AND e.event_date >= NOW()
               AND NOT EXISTS (SELECT 1 FROM registration_slots rs WHERE rs.registration_id = r.id)
           ) upcoming
           ORDER BY event_date ASC, start_time ASC NULLS LAST LIMIT 1`, [req.user.id])
  ]);
  res.json({
    registrations: registrations.rows[0].count,
    verifiedPayments: payments.rows[0].count,
    unreadNotifications: notifications.rows[0].count,
    nextEvent: nextEvent.rows[0] || null
  });
}));

app.get("/api/events", asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT e.*,
      COALESCE((SELECT ROUND(AVG(cr.rating)::numeric, 1) FROM court_reviews cr WHERE cr.event_id = e.id), 0) AS rating,
      (SELECT COUNT(*)::int FROM court_reviews cr WHERE cr.event_id = e.id) AS review_count,
      COUNT(r.id)::int AS registered_count,
      (e.max_participants - COUNT(r.id))::int AS available_slots,
      EXISTS(SELECT 1 FROM registrations mine WHERE mine.event_id = e.id AND mine.user_id = $1 AND mine.status <> 'cancelled') AS registered,
      (SELECT mine.status FROM registrations mine WHERE mine.event_id = e.id AND mine.user_id = $1 AND mine.status <> 'cancelled' LIMIT 1) AS registration_status
    FROM events e
    LEFT JOIN registrations r ON r.event_id = e.id AND r.status <> 'cancelled'
    WHERE e.status = 'published'
    GROUP BY e.id
    ORDER BY e.event_date ASC`, [req.session.user?.id || 0]);
  res.json({ events: result.rows });
}));

app.get("/api/courts/:courtId", asyncRoute(async (req, res) => {
  const courtId = Number(req.params.courtId);
  if (!Number.isInteger(courtId)) return res.status(400).json({ error: "Invalid court." });
  const result = await query(`
    SELECT e.*,
      COALESCE((SELECT ROUND(AVG(cr.rating)::numeric, 1) FROM court_reviews cr WHERE cr.event_id = e.id), 0) AS rating,
      (SELECT COUNT(*)::int FROM court_reviews cr WHERE cr.event_id = e.id) AS review_count
    FROM events e
    WHERE e.id = $1 AND e.status = 'published'`, [courtId]);
  if (!result.rowCount) return res.status(404).json({ error: "Court not found." });
  res.json({ court: result.rows[0] });
}));

app.get("/api/courts/:courtId/reviews", asyncRoute(async (req, res) => {
  const courtId = Number(req.params.courtId);
  if (!Number.isInteger(courtId)) return res.status(400).json({ error: "Invalid court." });
  const court = await query("SELECT id FROM events WHERE id = $1 AND status = 'published'", [courtId]);
  if (!court.rowCount) return res.status(404).json({ error: "Court not found." });

  const reviews = await query(`
    SELECT cr.id, cr.rating, cr.comment, cr.created_at, cr.updated_at,
      p.full_name, cr.user_id
    FROM court_reviews cr
    JOIN profiles p ON p.user_id = cr.user_id
    WHERE cr.event_id = $1
    ORDER BY cr.created_at DESC`, [courtId]);
  let myReview = null;
  let canReview = false;

  if (req.session.user) {
    myReview = reviews.rows.find((review) => review.user_id === req.session.user.id) || null;
    if (req.session.user.role === "member") {
      const booking = await query(
        "SELECT id FROM registrations WHERE user_id = $1 AND event_id = $2 AND status = 'confirmed' LIMIT 1",
        [req.session.user.id, courtId]
      );
      canReview = Boolean(booking.rowCount);
    }
  }

  res.json({
    reviews: reviews.rows.map(({ user_id, ...review }) => review),
    myReview,
    canReview
  });
}));

app.post("/api/courts/:courtId/reviews", requireAuth, asyncRoute(async (req, res) => {
  const courtId = Number(req.params.courtId);
  const rating = Number(req.body.rating);
  const comment = clean(req.body.comment, 1000);
  if (!Number.isInteger(courtId)) return res.status(400).json({ error: "Invalid court." });
  if (req.user.role !== "member") return res.status(403).json({ error: "Only members can rate a court." });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Choose a rating from 1 to 5." });
  }

  const court = await query("SELECT id, name FROM events WHERE id = $1 AND status = 'published'", [courtId]);
  if (!court.rowCount) return res.status(404).json({ error: "Court not found." });
  const booking = await query(
    "SELECT id FROM registrations WHERE user_id = $1 AND event_id = $2 AND status = 'confirmed' LIMIT 1",
    [req.user.id, courtId]
  );
  if (!booking.rowCount) {
    return res.status(403).json({ error: "You can rate this court after your booking is approved." });
  }

  const result = await query(`
    INSERT INTO court_reviews (event_id, user_id, rating, comment)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (event_id, user_id)
    DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = NOW()
    RETURNING id, rating, comment, created_at, updated_at`,
    [courtId, req.user.id, rating, comment || null]
  );
  await query(`
    UPDATE events
    SET rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM court_reviews WHERE event_id = $1), 0),
        review_count = (SELECT COUNT(*)::int FROM court_reviews WHERE event_id = $1),
        updated_at = NOW()
    WHERE id = $1`, [courtId]);
  res.status(201).json({ review: result.rows[0], court: court.rows[0] });
}));

app.get("/api/slots", asyncRoute(async (req, res) => {
  const courtId = Number(req.query.courtId || req.query.eventId);
  const date = clean(req.query.date, 10);
  if (!Number.isInteger(courtId) || !validSlotDate(date)) return res.status(400).json({ error: "Choose a valid court and date." });
  const court = await query(`
    SELECT e.*,
      COALESCE((SELECT ROUND(AVG(cr.rating)::numeric, 1) FROM court_reviews cr WHERE cr.event_id = e.id), 0) AS rating,
      (SELECT COUNT(*)::int FROM court_reviews cr WHERE cr.event_id = e.id) AS review_count
    FROM events e
    WHERE e.id = $1 AND e.status = 'published'`, [courtId]);
  if (!court.rowCount) return res.status(404).json({ error: "Court not found." });
  await ensureCourtSlots(courtId, date);
  const slots = await query(`
    SELECT cs.id, cs.slot_date, cs.start_time, cs.end_time, cs.price, cs.status,
      CASE WHEN cs.status = 'blocked' THEN 'unavailable'
           WHEN r.id IS NOT NULL THEN 'booked'
           ELSE 'open' END AS availability,
      COALESCE(r.user_id = $2, FALSE) AS mine
    FROM court_slots cs
    LEFT JOIN registration_slots rs ON rs.slot_id = cs.id
    LEFT JOIN registrations r ON r.id = rs.registration_id AND r.status <> 'cancelled'
    JOIN events e ON e.id = cs.event_id
      WHERE cs.event_id = $1 AND cs.slot_date = $3
        AND cs.start_time >= e.opening_time
        AND cs.start_time < LEAST(e.closing_time, TIME '23:00')
    ORDER BY cs.start_time ASC`, [courtId, req.session.user?.id || 0, date]);
  res.json({ court: court.rows[0], slots: slots.rows });
}));

app.post("/api/slots/book", requireAuth, asyncRoute(async (req, res) => {
  const courtId = Number(req.body.courtId);
  const slotIds = [...new Set((Array.isArray(req.body.slotIds) ? req.body.slotIds : [req.body.slotIds]).map(Number).filter(Number.isInteger))];
  if (!Number.isInteger(courtId) || !slotIds.length) return res.status(400).json({ error: "Select at least one open slot." });
  const court = await query("SELECT * FROM events WHERE id = $1 AND status = 'published'", [courtId]);
  if (!court.rowCount) return res.status(404).json({ error: "Court not found or no longer available." });
  const slots = await query(`
    SELECT cs.id, cs.price, cs.event_id, cs.status, active_booking.id AS active_booking_id
     FROM court_slots cs
     LEFT JOIN registration_slots rs ON rs.slot_id = cs.id
     LEFT JOIN registrations active_booking
       ON active_booking.id = rs.registration_id AND active_booking.status <> 'cancelled'
    WHERE cs.event_id = $1 AND cs.id = ANY($2::int[])`, [courtId, slotIds]);
  if (slots.rows.length !== slotIds.length || slots.rows.some((slot) => slot.status !== "open" || slot.active_booking_id)) {
    return res.status(409).json({ error: "One or more selected slots are no longer available. Please refresh and choose again." });
  }
  const duplicate = await query("SELECT id, status FROM registrations WHERE user_id = $1 AND event_id = $2", [req.user.id, courtId]);
  if (duplicate.rowCount && duplicate.rows[0].status !== "cancelled") return res.status(409).json({ error: "You already have a booking request for this court." });
  const registration = duplicate.rowCount
    ? await query("UPDATE registrations SET status = 'pending', registered_at = NOW() WHERE id = $1 RETURNING id", [duplicate.rows[0].id])
    : await query("INSERT INTO registrations (user_id, event_id) VALUES ($1, $2) RETURNING id", [req.user.id, courtId]);
  const registrationId = registration.rows[0].id;
  if (duplicate.rowCount) await query("DELETE FROM registration_slots WHERE registration_id = $1", [registrationId]);
  for (const slotId of slotIds) await query("INSERT INTO registration_slots (registration_id, slot_id) VALUES ($1, $2)", [registrationId, slotId]);
  const total = slots.rows.reduce((sum, slot) => sum + Number(slot.price), 0);
  await createNotification(req.user.id, "Court booking submitted", `Your request for ${court.rows[0].name} is waiting for admin approval.`, "success");
  res.status(201).json({ registrationId, total });
}));

app.post("/api/events/:eventId/register", requireAuth, asyncRoute(async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(eventId)) return res.status(400).json({ error: "Invalid event." });
  const event = await query("SELECT * FROM events WHERE id = $1 AND status = 'published'", [eventId]);
  if (!event.rowCount) return res.status(404).json({ error: "Event not found or no longer published." });
  const duplicate = await query("SELECT id, status FROM registrations WHERE user_id = $1 AND event_id = $2", [req.user.id, eventId]);
  if (duplicate.rowCount && duplicate.rows[0].status !== "cancelled") return res.status(409).json({ error: "You are already registered for this event." });
  const count = await query("SELECT COUNT(*)::int AS count FROM registrations WHERE event_id = $1 AND status <> 'cancelled'", [eventId]);
  if (count.rows[0].count >= event.rows[0].max_participants) return res.status(409).json({ error: "This event is already full." });
  const registration = duplicate.rowCount
    ? await query("UPDATE registrations SET status = 'pending', registered_at = NOW() WHERE id = $1 RETURNING id", [duplicate.rows[0].id])
    : await query("INSERT INTO registrations (user_id, event_id) VALUES ($1, $2) RETURNING id", [req.user.id, eventId]);
  await createNotification(req.user.id, "Registration submitted", `Your request for ${event.rows[0].name} is waiting for admin approval. You can submit payment proof after it is approved.`, "success");
  res.status(201).json({ registrationId: registration.rows[0].id, total: Number(event.rows[0].fee) });
}));

app.get("/api/registrations", requireAuth, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT r.id, r.status, r.registered_at, e.id AS event_id, e.name, e.event_date,
      COALESCE((SELECT MIN(cs.slot_date) FROM registration_slots rs JOIN court_slots cs ON cs.id = rs.slot_id WHERE rs.registration_id = r.id), e.event_date::date) AS booking_date,
      e.location, e.category, e.fee,
      latest_payment.status AS payment_status,
      CASE
        WHEN latest_payment.status = 'verified' THEN 'fully_confirmed'
        WHEN latest_payment.status = 'pending' THEN 'payment_pending'
        WHEN r.status = 'confirmed' THEN 'awaiting_payment'
        ELSE 'pending_approval'
      END AS confirmation_status,
      (SELECT STRING_AGG(TO_CHAR(cs.start_time, 'HH12:MI AM') || ' – ' || TO_CHAR(cs.end_time, 'HH12:MI AM'), CHR(10) ORDER BY cs.start_time)
       FROM registration_slots rs JOIN court_slots cs ON cs.id = rs.slot_id WHERE rs.registration_id = r.id) AS slot_times
    FROM registrations r JOIN events e ON e.id = r.event_id
    LEFT JOIN LATERAL (
      SELECT p.status FROM payments p
      WHERE p.registration_id = r.id
      ORDER BY p.submitted_at DESC
      LIMIT 1
    ) latest_payment ON TRUE
    WHERE r.user_id = $1 ORDER BY e.event_date DESC`, [req.user.id]);
  res.json({ registrations: result.rows });
}));

app.patch("/api/registrations/:id/cancel", requireAuth, asyncRoute(async (req, res) => {
  const booking = await query(
    `SELECT r.id, r.event_id, e.name
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     WHERE r.id = $1 AND r.user_id = $2 AND r.status <> 'cancelled'`,
    [Number(req.params.id), req.user.id]
  );
  if (!booking.rowCount) return res.status(404).json({ error: "Active booking not found." });
  const registrationId = booking.rows[0].id;
  await query("UPDATE registrations SET status = 'cancelled' WHERE id = $1", [registrationId]);
  await query("DELETE FROM registration_slots WHERE registration_id = $1", [registrationId]);
  await createNotification(
    req.user.id,
    "Booking cancelled",
    `Your booking for ${booking.rows[0].name} was cancelled and the time slots are open again.`,
    "info"
  );
  res.json({ ok: true });
}));

app.get("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const result = await query("SELECT u.email, u.role, p.* FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1", [req.user.id]);
  res.json({ profile: result.rows[0] });
}));

app.put("/api/profile", requireAuth, asyncRoute(async (req, res) => {
  const fullName = clean(req.body.fullName, 120);
  const phone = clean(req.body.phone, 30);
  const city = clean(req.body.city, 100);
  const skillLevel = clean(req.body.skillLevel, 40);
  if (!fullName) return res.status(400).json({ error: "Full name is required." });
  await query(
    "UPDATE profiles SET full_name = $1, phone = $2, city = $3, skill_level = $4, updated_at = NOW() WHERE user_id = $5",
    [fullName, phone, city, skillLevel, req.user.id]
  );
  req.session.user.fullName = fullName;
  res.json({ ok: true });
}));

app.get("/api/schedules", requireAuth, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT s.id, s.title, s.schedule_date, s.start_time, s.end_time, s.location, s.notes,
      s.created_at, s.updated_at, 'manual' AS source, NULL::varchar AS booking_status,
      NULL::varchar AS payment_status, 'fully_confirmed' AS confirmation_status,
      CASE WHEN s.schedule_date < CURRENT_DATE
        OR (s.schedule_date = CURRENT_DATE AND COALESCE(s.end_time, s.start_time) <= LOCALTIME)
        THEN TRUE ELSE FALSE END AS completed
    FROM schedules s
    WHERE s.user_id = $1
    UNION ALL
    SELECT -((r.id * 1000000) + cs.id) AS id, e.name AS title, cs.slot_date AS schedule_date,
      cs.start_time, cs.end_time, e.location,
      CONCAT('Court booking · ', INITCAP(r.status)) AS notes,
      r.registered_at AS created_at, r.registered_at AS updated_at,
      'booking' AS source, r.status AS booking_status,
      latest_payment.status AS payment_status,
      CASE
        WHEN latest_payment.status = 'verified' THEN 'fully_confirmed'
        WHEN latest_payment.status = 'pending' THEN 'payment_pending'
        WHEN r.status = 'confirmed' THEN 'awaiting_payment'
        ELSE 'pending_approval'
      END AS confirmation_status,
      CASE WHEN cs.slot_date < CURRENT_DATE
        OR (cs.slot_date = CURRENT_DATE AND cs.end_time <= LOCALTIME)
        THEN TRUE ELSE FALSE END AS completed
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    JOIN registration_slots rs ON rs.registration_id = r.id
    JOIN court_slots cs ON cs.id = rs.slot_id
    LEFT JOIN LATERAL (
      SELECT p.status FROM payments p
      WHERE p.registration_id = r.id
      ORDER BY p.submitted_at DESC
      LIMIT 1
    ) latest_payment ON TRUE
    WHERE r.user_id = $1 AND r.status <> 'cancelled'
    ORDER BY schedule_date ASC, start_time ASC`,
    [req.user.id]
  );
  res.json({ schedules: result.rows });
}));

app.post("/api/schedules", requireMember, asyncRoute(async (req, res) => {
  const values = scheduleValues(req.body);
  if (values.error) return res.status(400).json({ error: values.error });
  const result = await query(
    `INSERT INTO schedules (user_id, title, schedule_date, start_time, end_time, location, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.user.id, ...values.params]
  );
  res.status(201).json({ schedule: result.rows[0] });
}));

app.put("/api/schedules/:id", requireMember, asyncRoute(async (req, res) => {
  const values = scheduleValues(req.body);
  if (values.error) return res.status(400).json({ error: values.error });
  const result = await query(
    `UPDATE schedules SET title=$1, schedule_date=$2, start_time=$3, end_time=$4, location=$5, notes=$6, updated_at=NOW()
     WHERE id=$7 AND user_id=$8 RETURNING *`,
    [...values.params, Number(req.params.id), req.user.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Schedule not found." });
  res.json({ schedule: result.rows[0] });
}));

app.delete("/api/schedules/:id", requireMember, asyncRoute(async (req, res) => {
  const result = await query("DELETE FROM schedules WHERE id = $1 AND user_id = $2 RETURNING id", [Number(req.params.id), req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: "Schedule not found." });
  res.json({ ok: true });
}));

app.get("/api/payments", requireAuth, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT p.*, e.name AS event_name, e.event_date, e.fee, r.status AS registration_status
    FROM payments p JOIN events e ON e.id = p.event_id JOIN registrations r ON r.id = p.registration_id
    WHERE p.user_id = $1 ORDER BY p.submitted_at DESC`, [req.user.id]);
  res.json({ payments: result.rows });
}));

app.post("/api/payments", requireAuth, upload.single("proof"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a JPG, PNG, or WEBP payment screenshot up to 5MB." });
  const registrationId = Number(req.body.registrationId);
  const amount = Number(req.body.amount);
  const paymentDate = clean(req.body.paymentDate, 20);
  const notes = clean(req.body.notes, 1000);
  const registration = await query(`
    SELECT r.*, e.name, e.fee FROM registrations r JOIN events e ON e.id = r.event_id
    WHERE r.id = $1 AND r.user_id = $2`, [registrationId, req.user.id]);
  if (!registration.rowCount || !Number.isFinite(amount) || amount < 0 || !isDate(paymentDate)) {
    return res.status(400).json({ error: "Complete the payment form with a valid amount and date." });
  }
  if (registration.rows[0].status !== "confirmed") {
    return res.status(400).json({ error: "Your registration must be approved by an admin before submitting payment." });
  }
  if (amount !== Number(registration.rows[0].fee)) {
    return res.status(400).json({ error: `The amount must match the registration fee of ₱${Number(registration.rows[0].fee).toLocaleString()}.` });
  }
  const fileId = newUploadId();
  await saveUpload(req.file, fileId);
  let result;
  try {
    result = await query(`
      INSERT INTO payments (registration_id, user_id, event_id, amount, payment_date, proof_path, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [registrationId, req.user.id, registration.rows[0].event_id, amount, paymentDate, `/uploads/${fileId}`, notes]
    );
  } catch (error) {
    await deleteUpload(fileId).catch(() => {});
    throw error;
  }
  await createNotification(req.user.id, "Payment proof submitted", `Your proof for ${registration.rows[0].name} is now pending admin review.`, "info");
  res.status(201).json({ paymentId: result.rows[0].id });
}));

app.get("/api/notifications", requireAuth, asyncRoute(async (req, res) => {
  const result = await query("SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [req.user.id]);
  res.json({ notifications: result.rows });
}));

app.post("/api/notifications/read", requireAuth, asyncRoute(async (req, res) => {
  await query("UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
  res.json({ ok: true });
}));

app.get("/api/admin/stats", requireAdmin, asyncRoute(async (req, res) => {
  const [users, events, registrations, pendingPayments, revenue] = await Promise.all([
    query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'member'"),
    query("SELECT COUNT(*)::int AS count FROM events WHERE status = 'published'"),
    query("SELECT COUNT(*)::int AS count FROM registrations WHERE status <> 'cancelled'"),
    query("SELECT COUNT(*)::int AS count FROM payments WHERE status = 'pending'"),
    query("SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE status = 'verified'")
  ]);
  res.json({
    users: users.rows[0].count,
    events: events.rows[0].count,
    registrations: registrations.rows[0].count,
    pendingPayments: pendingPayments.rows[0].count,
    revenue: Number(revenue.rows[0].total)
  });
}));

app.get("/api/admin/users", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT u.id, u.email, u.role, u.is_super_admin, u.admin_requested, u.admin_approved, u.created_at,
      p.full_name, p.phone, p.city, p.skill_level, COUNT(DISTINCT r.id)::int AS registrations
    FROM users u JOIN profiles p ON p.user_id = u.id
    LEFT JOIN registrations r ON r.user_id = u.id
    GROUP BY u.id, p.id ORDER BY u.created_at DESC`);
  res.json({ users: result.rows });
}));

app.delete("/api/admin/users/:id", requireAdmin, asyncRoute(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid account." });
  if (targetId === req.user.id) return res.status(400).json({ error: "Use account settings to delete your own account." });
  const target = await query(
    "SELECT id, email, role, is_super_admin FROM users WHERE id = $1",
    [targetId]
  );
  if (!target.rowCount) return res.status(404).json({ error: "Account not found." });
  if (target.rows[0].is_super_admin) {
    return res.status(403).json({ error: "The super admin account is protected." });
  }
  if (target.rows[0].role === "admin" && !req.user.isSuperAdmin) {
    return res.status(403).json({ error: "Only the super admin can delete another administrator." });
  }
  const deleted = await removeUserAccount(targetId);
  if (!deleted.rowCount) return res.status(404).json({ error: "Account not found." });
  res.json({ ok: true });
}));

app.post("/api/admin/users", requireAdmin, asyncRoute(async (req, res) => {
  const email = emailOf(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const fullName = clean(req.body.fullName, 120);
  const accountType = req.body.accountType === "admin" ? "admin" : "member";
  if (!email || !email.includes("@") || password.length < 8 || !fullName) {
    return res.status(400).json({ error: "Enter a name, valid email, and password of at least 8 characters." });
  }
  if (accountType === "admin" && !req.user.isSuperAdmin) {
    return res.status(403).json({ error: "Only the super admin can create administrator accounts." });
  }
  const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) return res.status(409).json({ error: "An account with that email already exists." });
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO users (email, password_hash, role, is_super_admin, admin_approved)
     VALUES ($1, $2, $3, FALSE, TRUE) RETURNING id, email, role`,
    [email, passwordHash, accountType]
  );
  await query("INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)", [result.rows[0].id, fullName]);
  await createNotification(result.rows[0].id, "PickleBalls account created", "Your account was created by an administrator. You can now sign in.", "success");
  res.status(201).json({ user: result.rows[0] });
}));

app.patch("/api/admin/users/:id/admin-approval", requireSuperAdmin, asyncRoute(async (req, res) => {
  const action = clean(req.body.action, 20);
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "Choose approve or reject." });
  const approved = action === "approve";
  const result = await query(
    `UPDATE users SET role=$1, admin_requested=FALSE, admin_approved=$2
     WHERE id=$3 AND admin_requested=TRUE
     RETURNING id, email, role`,
    [approved ? "admin" : "member", approved, Number(req.params.id)]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Pending admin request not found." });
  await createNotification(
    result.rows[0].id,
    approved ? "Admin request approved" : "Admin request declined",
    approved ? "Your administrator account is approved. You can now sign in to the admin console." : "Your administrator account request was declined. You can still use your PickleBalls member account.",
    approved ? "success" : "warning"
  );
  res.json({ ok: true });
}));

app.get("/api/admin/schedules", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT s.id, s.title, s.schedule_date, s.start_time, s.end_time, s.location, s.notes,
      s.created_at, s.updated_at, 'manual' AS source, NULL::varchar AS booking_status,
      NULL::varchar AS payment_status, 'fully_confirmed' AS confirmation_status,
      p.full_name, p.phone, u.email,
      CASE WHEN s.schedule_date < CURRENT_DATE
        OR (s.schedule_date = CURRENT_DATE AND COALESCE(s.end_time, s.start_time) <= LOCALTIME)
        THEN TRUE ELSE FALSE END AS completed
    FROM schedules s
    JOIN users u ON u.id = s.user_id
    JOIN profiles p ON p.user_id = u.id

    UNION ALL

    SELECT -((r.id * 1000000) + cs.id) AS id, e.name AS title, cs.slot_date AS schedule_date,
      cs.start_time, cs.end_time, e.location,
      CONCAT('Court booking · ', INITCAP(r.status)) AS notes,
      r.registered_at AS created_at, r.registered_at AS updated_at,
      'booking' AS source, r.status AS booking_status,
      latest_payment.status AS payment_status,
      CASE
        WHEN latest_payment.status = 'verified' THEN 'fully_confirmed'
        WHEN latest_payment.status = 'pending' THEN 'payment_pending'
        WHEN r.status = 'confirmed' THEN 'awaiting_payment'
        ELSE 'pending_approval'
      END AS confirmation_status,
      p.full_name, p.phone, u.email,
      CASE WHEN cs.slot_date < CURRENT_DATE
        OR (cs.slot_date = CURRENT_DATE AND cs.end_time <= LOCALTIME)
        THEN TRUE ELSE FALSE END AS completed
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    JOIN registration_slots rs ON rs.registration_id = r.id
    JOIN court_slots cs ON cs.id = rs.slot_id
    JOIN users u ON u.id = r.user_id
    JOIN profiles p ON p.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT payment.status FROM payments payment
      WHERE payment.registration_id = r.id
      ORDER BY payment.submitted_at DESC
      LIMIT 1
    ) latest_payment ON TRUE
    WHERE r.status <> 'cancelled'

    ORDER BY schedule_date ASC, start_time ASC`);
  res.json({ schedules: result.rows });
}));

app.get("/api/admin/events", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT e.*,
      COALESCE((SELECT ROUND(AVG(cr.rating)::numeric, 1) FROM court_reviews cr WHERE cr.event_id = e.id), 0) AS rating,
      (SELECT COUNT(*)::int FROM court_reviews cr WHERE cr.event_id = e.id) AS review_count,
      COUNT(r.id)::int AS registered_count,
      (e.max_participants - COUNT(r.id))::int AS available_slots
    FROM events e LEFT JOIN registrations r ON r.event_id = e.id AND r.status <> 'cancelled'
    GROUP BY e.id ORDER BY e.event_date DESC`);
  res.json({ events: result.rows });
}));

app.post("/api/admin/events", requireAdmin, upload.single("image"), asyncRoute(async (req, res) => {
  const fileId = req.file ? newUploadId() : "";
  const values = eventValues(req.body, fileId ? `/court-images/${fileId}` : "");
  if (values.error) {
    return res.status(400).json({ error: values.error });
  }
  if (req.file) await saveUpload(req.file, fileId);
  let result;
  try {
    result = await query(`
      INSERT INTO events (name, event_date, location, description, category, fee, max_participants, status, image_url, surface, contact, opening_time, closing_time, amenities, rate_rules)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb) RETURNING *`, values.params);
  } catch (error) {
    if (fileId) await deleteUpload(fileId).catch(() => {});
    throw error;
  }
  res.status(201).json({ event: result.rows[0] });
}));

app.put("/api/admin/events/:id", requireAdmin, upload.single("image"), asyncRoute(async (req, res) => {
  const existing = await query("SELECT image_url, rate_rules FROM events WHERE id = $1", [Number(req.params.id)]);
  const fileId = req.file ? newUploadId() : "";
  const imagePath = fileId ? `/court-images/${fileId}` : (clean(req.body.imageUrl, 1000) || existing.rows[0]?.image_url || "");
  const body = { ...req.body };
  if (!body.rateRules && existing.rows[0]?.rate_rules) body.rateRules = JSON.stringify(existing.rows[0].rate_rules);
  const values = eventValues(body, imagePath);
  if (values.error) {
    return res.status(400).json({ error: values.error });
  }
  if (req.file) await saveUpload(req.file, fileId);
  let result;
  try {
    result = await query(`
      UPDATE events SET name=$1, event_date=$2, location=$3, description=$4, category=$5, fee=$6, max_participants=$7, status=$8, image_url=$9, surface=$10, contact=$11, opening_time=$12, closing_time=$13, amenities=$14::jsonb, rate_rules=$15::jsonb, updated_at=NOW()
      WHERE id=$16 RETURNING *`, [...values.params, Number(req.params.id)]);
  } catch (error) {
    if (fileId) await deleteUpload(fileId).catch(() => {});
    throw error;
  }
  if (!result.rowCount) return res.status(404).json({ error: "Event not found." });
  res.json({ event: result.rows[0] });
}));

app.delete("/api/admin/events/:id", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query("DELETE FROM events WHERE id = $1 RETURNING id", [Number(req.params.id)]);
  if (!result.rowCount) return res.status(404).json({ error: "Event not found." });
  res.json({ ok: true });
}));

app.get("/api/admin/registrations", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT r.id, r.status, r.registered_at, e.name AS event_name, e.event_date, u.email, p.full_name, p.phone,
      latest_payment.status AS payment_status,
      CASE
        WHEN latest_payment.status = 'verified' THEN 'fully_confirmed'
        WHEN latest_payment.status = 'pending' THEN 'payment_pending'
        WHEN r.status = 'confirmed' THEN 'awaiting_payment'
        ELSE 'pending_approval'
      END AS confirmation_status,
      (SELECT STRING_AGG(TO_CHAR(cs.start_time, 'HH12:MI AM') || '–' || TO_CHAR(cs.end_time, 'HH12:MI AM'), ', ' ORDER BY cs.start_time)
       FROM registration_slots rs JOIN court_slots cs ON cs.id = rs.slot_id WHERE rs.registration_id = r.id) AS slot_times
    FROM registrations r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id JOIN profiles p ON p.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT payment.status FROM payments payment
      WHERE payment.registration_id = r.id
      ORDER BY payment.submitted_at DESC
      LIMIT 1
    ) latest_payment ON TRUE
    ORDER BY r.registered_at DESC`);
  res.json({ registrations: result.rows });
}));

app.patch("/api/admin/registrations/:id", requireAdmin, asyncRoute(async (req, res) => {
  const action = clean(req.body.action, 20);
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "Choose approve or reject." });
  const status = action === "approve" ? "confirmed" : "cancelled";
  const result = await query(
    `UPDATE registrations SET status=$1
     WHERE id=$2 AND status='pending'
     RETURNING id, user_id, event_id`,
    [status, Number(req.params.id)]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Pending registration not found." });
  if (status === "cancelled") await query("DELETE FROM registration_slots WHERE registration_id = $1", [result.rows[0].id]);
  const event = await query("SELECT name FROM events WHERE id = $1", [result.rows[0].event_id]);
  await createNotification(
    result.rows[0].user_id,
    action === "approve" ? "Registration approved" : "Registration declined",
    action === "approve" ? `Your registration for ${event.rows[0].name} was approved. You may now submit payment proof.` : `Your registration request for ${event.rows[0].name} was declined by the admin.`,
    action === "approve" ? "success" : "warning"
  );
  res.json({ ok: true });
}));

app.delete("/api/admin/registrations/:id", requireAdmin, asyncRoute(async (req, res) => {
  const booking = await query(
    `SELECT r.id, r.user_id, r.event_id, e.name
     FROM registrations r
     JOIN events e ON e.id = r.event_id
     WHERE r.id = $1 AND r.status <> 'cancelled'`,
    [Number(req.params.id)]
  );
  if (!booking.rowCount) return res.status(404).json({ error: "Active booking not found." });
  const registrationId = booking.rows[0].id;
  await query("UPDATE registrations SET status = 'cancelled' WHERE id = $1", [registrationId]);
  await query("DELETE FROM registration_slots WHERE registration_id = $1", [registrationId]);
  await createNotification(
    booking.rows[0].user_id,
    "Booking cancelled by admin",
    `Your booking for ${booking.rows[0].name} was cancelled by an administrator. The time slots are open again.`,
    "warning"
  );
  res.json({ ok: true });
}));

app.get("/api/admin/payments", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT p.*, e.name AS event_name, e.fee, u.email, pr.full_name, pr.phone
    FROM payments p JOIN events e ON e.id = p.event_id JOIN users u ON u.id = p.user_id JOIN profiles pr ON pr.user_id = u.id
    ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.submitted_at DESC`);
  res.json({ payments: result.rows });
}));

app.get("/api/admin/notifications", requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`
    SELECT n.*, p.full_name AS recipient_name
    FROM notifications n LEFT JOIN profiles p ON p.user_id = n.user_id
    ORDER BY n.created_at DESC LIMIT 100`);
  res.json({ notifications: result.rows });
}));

app.patch("/api/admin/payments/:id", requireAdmin, asyncRoute(async (req, res) => {
  const status = clean(req.body.status, 20);
  const reason = clean(req.body.reason, 500);
  if (!["verified", "rejected"].includes(status)) return res.status(400).json({ error: "Choose verified or rejected." });
  if (status === "rejected" && !reason) return res.status(400).json({ error: "A rejection reason is required." });
  const result = await query(`
    UPDATE payments SET status=$1, admin_reason=$2, reviewed_by=$3, reviewed_at=NOW()
    WHERE id=$4 RETURNING user_id, event_id`, [status, reason || null, req.user.id, Number(req.params.id)]);
  if (!result.rowCount) return res.status(404).json({ error: "Payment not found." });
  const event = await query("SELECT name FROM events WHERE id = $1", [result.rows[0].event_id]);
  await createNotification(
    result.rows[0].user_id,
    status === "verified" ? "Payment verified" : "Payment needs attention",
    status === "verified" ? `Your payment for ${event.rows[0].name} was verified. Your spot is confirmed.` : `Your payment for ${event.rows[0].name} was rejected: ${reason}`,
    status === "verified" ? "success" : "warning"
  );
  if (status === "verified") await query("UPDATE registrations SET status = 'confirmed' WHERE user_id = $1 AND event_id = $2", [result.rows[0].user_id, result.rows[0].event_id]);
  res.json({ ok: true });
}));

app.post("/api/admin/notifications", requireAdmin, asyncRoute(async (req, res) => {
  const title = clean(req.body.title, 160);
  const message = clean(req.body.message, 1000);
  const userId = req.body.userId ? Number(req.body.userId) : null;
  if (!title || !message) return res.status(400).json({ error: "Title and message are required." });
  if (userId) await createNotification(userId, title, message, "info");
  else await query("INSERT INTO notifications (user_id, title, message, type) SELECT id, $1, $2, 'info' FROM users WHERE role = 'member'", [title, message]);
  res.status(201).json({ ok: true });
}));

function scheduleValues(body) {
  const title = clean(body.title, 160);
  const scheduleDate = clean(body.scheduleDate, 20);
  const startTime = clean(body.startTime, 10);
  const endTime = clean(body.endTime, 10) || null;
  const location = clean(body.location, 180);
  const notes = clean(body.notes, 1000);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate) || !/^\d{2}:\d{2}$/.test(startTime) || (endTime && !/^\d{2}:\d{2}$/.test(endTime)) || (endTime && endTime <= startTime) || !location) {
    return { error: "Complete the schedule title, date, start time, and location. End time must be after start time." };
  }
  return { params: [title, scheduleDate, startTime, endTime, location, notes] };
}

function timeMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[2]) > 59 || Number(match[1]) > 23) return NaN;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes === 0 ? 1440 : minutes;
}

function timeText(minutes) {
  const normalized = minutes % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function jsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function courtAmenities(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || "").split(","))
    .map((item) => clean(item, 50))
    .filter(Boolean))].slice(0, 12);
}

function courtRateRules(body) {
  const submitted = jsonArray(body.rateRules);
  const validSubmitted = submitted
    .map((rule) => ({
      label: clean(rule.label, 80),
      start: clean(rule.start, 5),
      end: clean(rule.end, 5),
      price: Number(rule.price)
    }))
    .filter((rule) => rule.label && !Number.isNaN(timeMinutes(rule.start)) && !Number.isNaN(timeMinutes(rule.end)) && timeMinutes(rule.end) > timeMinutes(rule.start) && Number.isFinite(rule.price) && rule.price > 0);
  if (validSubmitted.length) return validSubmitted;
  const rules = [
    ["Early morning", "04:00", "08:00", body.morningPrice],
    ["Daytime", "08:00", "17:00", body.daytimePrice],
    ["Peak hours", "17:00", "00:00", body.eveningPrice]
  ];
  const parsed = rules
    .map(([label, start, end, price]) => ({ label, start, end, price: Number(price) }))
    .filter((rule) => Number.isFinite(rule.price) && rule.price > 0);
  if (parsed.length) return parsed;
  const fee = Number(body.fee);
  return Number.isFinite(fee) && fee > 0
    ? [{ label: "Standard rate", start: "00:00", end: "23:59", price: fee }]
    : [];
}

function eventValues(body, imagePath = "") {
  const name = clean(body.name, 160);
  const eventDate = clean(body.eventDate, 40) || new Date().toISOString();
  const location = clean(body.location, 180);
  const description = clean(body.description, 5000);
  const category = clean(body.category, 50);
  const fee = Number(body.fee);
  const maxParticipants = Number(body.maxParticipants);
  const status = clean(body.status || "draft", 20);
  const surface = clean(body.surface || "Sport Court", 80);
  const imageUrl = imagePath || clean(body.imageUrl, 1000);
  const contact = clean(body.contact, 40);
  const openingTime = clean(body.openingTime || "07:00", 5);
  const closingTime = clean(body.closingTime || "23:00", 5);
  const amenities = courtAmenities(body.amenities);
  const rateRules = courtRateRules(body);
  const openingMinutes = timeMinutes(openingTime);
  const closingMinutes = timeMinutes(closingTime);
  const validImage = imageUrl && (/^\/court-images\/[A-Za-z0-9._-]+$/.test(imageUrl) || /^https?:\/\/\S+$/i.test(imageUrl));
  if (!name || !isDate(eventDate) || !location || !description || !category || !surface || !Number.isFinite(fee) || fee <= 0 || !Number.isInteger(maxParticipants) || maxParticipants < 1 || !["draft", "published", "closed", "cancelled"].includes(status) || !validImage || !isPhone(contact) || Number.isNaN(openingMinutes) || Number.isNaN(closingMinutes) || closingMinutes <= openingMinutes || closingMinutes > 23 * 60 || !rateRules.length) {
    return { error: "Complete the court details, image, contact, hours until 11:00 PM, and at least one valid rate." };
  }
  return {
    params: [name, eventDate, location, description, category, fee, maxParticipants, status, imageUrl, surface, contact, openingTime, closingTime, JSON.stringify(amenities), JSON.stringify(rateRules)]
  };
}

async function ensureCourtSlots(eventId, date) {
  const court = await query("SELECT opening_time, closing_time, fee, rate_rules FROM events WHERE id = $1 AND status = 'published'", [eventId]);
  if (!court.rowCount) return;
  const opening = timeMinutes(String(court.rows[0].opening_time).slice(0, 5));
  const closing = Math.min(timeMinutes(String(court.rows[0].closing_time).slice(0, 5)), 23 * 60);
  const rules = jsonArray(court.rows[0].rate_rules);
  const fallbackPrice = Number(court.rows[0].fee || 0);
  const standardRule = rules.find((rule) => rule.label === "Standard rate");
  for (let minute = opening; minute < closing; minute += 60) {
    const end = Math.min(minute + 60, closing);
    const matchingRule = standardRule || rules.find((rule) => {
      const start = timeMinutes(rule.start);
      const ruleEnd = timeMinutes(rule.end);
      return !Number.isNaN(start) && !Number.isNaN(ruleEnd) && minute >= start && minute < ruleEnd;
    });
    const price = Number(matchingRule?.price);
    await query(
      `INSERT INTO court_slots (event_id, slot_date, start_time, end_time, price)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id, slot_date, start_time) DO NOTHING`,
      [eventId, date, timeText(minute), timeText(end), Number.isFinite(price) ? price : fallbackPrice]
    );
  }
}

function validSlotDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError || error.message?.includes("Unexpected field")) return res.status(400).json({ error: "Upload a JPG, PNG, or WEBP screenshot up to 5MB." });
  console.error(error);
  res.status(500).json({ error: "Something went wrong on the server." });
});

async function initialize() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = schema.split(";").map((item) => item.trim()).filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try {
      await query(statement);
    } catch (error) {
      throw new Error(`Database initialization failed at statement ${index + 1}: ${error.message}`);
    }
  }
  console.log("PickleBalls database ready");
}

const initialization = initialize();

if (process.env.VERCEL) {
  module.exports = async (req, res) => {
    try {
      await initialization;
      return app(req, res);
    } catch (error) {
      console.error("Startup failed:", error.message);
      res.statusCode = 500;
      return res.end("Server startup failed.");
    }
  };
} else {
  initialization
    .then(() => app.listen(port, "0.0.0.0", () => console.log(`PickleBalls listening on ${port}`)))
    .catch((error) => {
      console.error("Startup failed:", error.message);
      process.exit(1);
    });
}

// ==================================
// Pickleball Registration Website
//
// This project is developed for a pickleball registration
// website, including user registration, login, bookings,
// payments, profiles, and administrative features.
//
// Developed by: Joshua Apostol
// ==================================