import { fetchAuthSession } from "aws-amplify/auth";
import { config } from "../config.js";

async function getToken() {
  try {
    const session = await fetchAuthSession();
    return session?.tokens?.idToken?.toString() || null;
  } catch {
    return null;
  }
}

export async function apiFetch(
  path,
  { method = "GET", body, auth = false, query } = {}
) {
  const url = new URL(`${config.apiUrl}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, v);
      }
    });
  }

  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = await getToken();
    if (token) headers["Authorization"] = token;
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const message =
      (data && (data.message || data.error)) ||
      `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}
