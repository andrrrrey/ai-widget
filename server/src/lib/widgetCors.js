import { getProject } from "./store.js";

function normalizeOrigin(value) {
  if (!value) return null;

  const trimmed = String(value).trim().replace(/\/+$/, "");

  try {
    const u = new URL(trimmed);
    return { origin: u.origin.toLowerCase(), host: u.host.toLowerCase() };
  } catch (err) {
    // Not a full URL (e.g. "example.com") — fallback to host-only comparison
    return { origin: null, host: trimmed.toLowerCase() };
  }
}

/**
 * For widget routes we reflect Access-Control-Allow-Origin ONLY if origin is in allowed_origins.
 * If allowed_origins is empty -> deny by default (safer).
 *
 * Normalization notes:
 * - Allowed origins are trimmed + lowercased.
 * - Trailing slashes are ignored.
 * - Plain hostnames ("example.com") are supported alongside full origins.
 */
export async function widgetCors(req, res, next) {
  try {
    const rawOrigin = req.headers.origin;
    const projectId = req.params.projectId;

    // Non-browser (no Origin) — allow (e.g. curl/health), but for widget it's mostly browser anyway.
    if (!rawOrigin) return next();

    const originInfo = normalizeOrigin(rawOrigin);
    if (!originInfo) return res.status(400).json({ error: "invalid_origin" });

    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: "project_not_found" });

    const allowedList = Array.isArray(project.allowed_origins) ? project.allowed_origins : [];
    const normalizedAllowed = allowedList
      .map(normalizeOrigin)
      .filter(Boolean);

    const ok = normalizedAllowed.some((item) => {
      if (item.origin && originInfo.origin === item.origin) return true;
      if (item.host && originInfo.host === item.host) return true;
      return false;
    });

    if (!ok) {
      return res.status(403).json({ error: "origin_not_allowed", origin: rawOrigin });
    }

    res.setHeader("Access-Control-Allow-Origin", rawOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).end();
    }

    return next();
  } catch (e) {
    return res.status(500).json({ error: "cors_error", message: e?.message || String(e) });
  }
}
