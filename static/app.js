for (const el of document.querySelectorAll("[data-autosubmit]")) {
  el.addEventListener("change", () => el.form.submit());
}

for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirm)) {
      event.preventDefault();
    }
  });
}

const dateInput = document.getElementById("date");
if (dateInput) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
