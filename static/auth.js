import { api } from "./api.js";

const form = document.getElementById("auth-form");
const errorBox = document.getElementById("form-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const { email, password } = Object.fromEntries(new FormData(form));
  try {
    await api(form.dataset.endpoint, { method: "POST", body: { email, password } });
    location.href = "/";
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }
});