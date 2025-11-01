import axios from "axios";

/**
 * One shared Axios instance.
 * - baseURL "" = same-origin (recommended when Nginx proxies /api → backend)
 * - If you want, set VITE_API_BASE at build time (Vite) to override.
 */
export const api = axios.create({
  baseURL: import.meta.env?.VITE_API_BASE || "",
});