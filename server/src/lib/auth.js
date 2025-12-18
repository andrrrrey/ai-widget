import jwt from "jsonwebtoken";

const COOKIE = "aiw_admin";

function sign(payload) {
  const secret = process.env.JWT_SECRET || "dev-secret";
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

function verify(token) {
  const secret = process.env.JWT_SECRET || "dev-secret";
  return jwt.verify(token, secret);
}

export function requireAdmin(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    req.admin = verify(token);
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

export function loginHandler(req, res) {
  const login = String(req.body?.login || "");
  const password = String(req.body?.password || "");

  const goodLogin = process.env.ADMIN_LOGIN || "admin";
  const goodPass = process.env.ADMIN_PASSWORD || "change-me";

  if (login !== goodLogin || password !== goodPass) {
    return res.status(401).json({ error: "bad_credentials" });
  }

  const token = sign({ login, role: "superadmin" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ ok: true });
}

export function logoutHandler(req, res) {
  res.cookie(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 0,
  });
  res.json({ ok: true });
}
