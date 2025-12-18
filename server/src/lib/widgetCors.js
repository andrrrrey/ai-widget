import { getProject } from "./store.js";

/**
 * For widget routes we reflect Access-Control-Allow-Origin ONLY if origin is in allowed_origins.
 * If allowed_origins is empty -> deny by default (safer).
 */
export async function widgetCors(req, res, next) {
  try {
    const origin = req.headers.origin;
    const projectId = req.params.projectId;

    // Non-browser (no Origin) — allow (e.g. curl/health), but for widget it's mostly browser anyway.
    if (!origin) return next();

    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: "project_not_found" });

    const allowed = Array.isArray(project.allowed_origins) ? project.allowed_origins : [];
    const ok = allowed.includes(origin);

    if (!ok) {
      return res.status(403).json({ error: "origin_not_allowed", origin });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
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
