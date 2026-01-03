import crypto from "crypto";
import jwt from "jsonwebtoken";
import { findUserByEmail } from "./store.js";

const COOKIE = "aiw_session";

function sign(payload) {
  const secret = process.env.JWT_SECRET || "dev-secret";
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

function verify(token) {
  const secret = process.env.JWT_SECRET || "dev-secret";
  return jwt.verify(token, secret);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    req.auth = verify(token);
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

export function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.auth?.role === "admin") return next();
    return res.status(403).json({ error: "forbidden" });
  });
}

export function requireUser(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.auth?.role === "user") return next();
    return res.status(403).json({ error: "forbidden" });
  });
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, hash] = String(passwordHash || "").split(":");
  if (!salt || !hash) return false;
  const compare = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return compare === hash;
}

const secureCookies = process.env.NODE_ENV === "production";

export async function loginHandler(req, res) {
  const login = String(req.body?.login || "").toLowerCase();
  const password = String(req.body?.password || "");

  const goodLogin = (process.env.ADMIN_LOGIN || "admin").toLowerCase();
  const goodPass = process.env.ADMIN_PASSWORD || "change-me";

  if (login === goodLogin && password === goodPass) {
    const token = sign({ login, role: "admin" });
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      maxAge: 7 * 24 * 3600 * 1000,
    });
    return res.json({ ok: true, role: "admin" });
  }

  const user = await findUserByEmail(login);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "bad_credentials" });
  }

  const token = sign({ login: user.email, role: user.role || "user", userId: user.id });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ ok: true, role: user.role || "user", user: { id: user.id, email: user.email } });
}

export function logoutHandler(req, res) {
  res.cookie(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    maxAge: 0,
  });
  res.json({ ok: true });
}

export async function sessionHandler(req, res) {
  const role = req.auth?.role;
  if (!role) return res.status(401).json({ error: "unauthorized" });

  if (role === "admin") {
    return res.json({ ok: true, role: "admin" });
  }

  const user = await findUserByEmail(req.auth?.login);
  if (!user) return res.status(401).json({ error: "unauthorized" });

  return res.json({ ok: true, role: user.role || "user", user: { id: user.id, email: user.email } });
}