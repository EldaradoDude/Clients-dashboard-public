// Calls to the app.py JSON endpoints. Errors carry the server's message.

// When the session has ended, open the login page, which comes back here afterwards.
export function toLogin() {
  location.assign(`/login.html?${new URLSearchParams({ next: location.pathname + location.search })}`);
}

async function request(path, init, { redirectOn401 = true } = {}) {
  const res = await fetch(path, init);
  const body = await res.json();
  if (res.status === 401 && redirectOn401) toLogin();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// An array value is sent as a repeated parameter.
function getJSON(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) for (const v of [value].flat()) query.append(key, v);
  return request(`${path}?${query}`);
}

const postJSON = (path, data = {}, options) => request(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
}, options);

export const login = (username, password) =>
  postJSON("/api/login", { username, password }, { redirectOn401: false });

export const logout = () => postJSON("/api/logout");

export const fetchMe = () => getJSON("/api/me");

export const fetchOptions = () => getJSON("/api/options");

export const fetchOrderbook = ({ venue, symbol, start, end }) =>
  getJSON("/api/orderbook", { venue, symbol, start, end });

export const fetchDepth = ({ venue, symbol, start, end }) =>
  getJSON("/api/depth", { venue, symbol, start, end });

export const fetchMid = ({ venue, symbol, start, end }) =>
  getJSON("/api/mid", { venue, symbol, start, end });

// `accounts` are "venue:account"; `symbol` is a pair key.
export const fetchBalance = ({ accounts, symbol, start, end }) =>
  getJSON("/api/balance", { account: accounts, symbol, start, end });

export const fetchTrades = ({ accounts, symbol, start, end }) =>
  getJSON("/api/trades", { account: accounts, symbol, start, end });
