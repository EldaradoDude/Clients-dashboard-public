// Entry point of login.html: log in, then open ?next= (the page that sent us here).

import { login } from "./api.js";
import { $ } from "./dom.js";

// Only a path on this site, so a crafted link can't send the user elsewhere after login.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next") ?? "";
  return /^\/(?![/\\])/.test(next) ? next : "/";
}

$("login").addEventListener("submit", async e => {
  e.preventDefault();
  $("submit").disabled = true;
  $("error").hidden = true;
  try {
    await login($("username").value, $("password").value);
    location.replace(nextPage());
  } catch (err) {
    $("error").textContent = err.message;
    $("error").hidden = false;
    $("password").select();
  } finally {
    $("submit").disabled = false;
  }
});
