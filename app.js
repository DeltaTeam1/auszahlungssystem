const DATA_SHEET_URL = [
  "https://docs.google.com/spreadsheets/d/",
  "13IjN7-7c9iwyciluIfDZNfCHFl7TlOMoHP8l00n77_E",
  "/gviz/tq?sheet=data_auszahlung",
].join("");
const DATA_SHEET_HASH = "47bc3188da412e6a749fc37070791332712cc90969213a9c2f60fb3681f3420c";
const DATA_SHEET_NAME = "data_auszahlung";
const DATABASE_API_URL = String(window.APP_CONFIG?.googleAppsScriptUrl ?? "").trim();

const requestForm = document.querySelector("#request-form");
const recordsBody = document.querySelector("#records-body");
const recordTemplate = document.querySelector("#record-template");
const emptyState = document.querySelector("#empty-state");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const gotaPassword = document.querySelector("#gota-password");
const formFeedback = document.querySelector("#form-feedback");
const authFeedback = document.querySelector("#auth-feedback");
const securityState = document.querySelector("#security-state");
const securityCopy = document.querySelector("#security-copy");
const gotaTrigger = document.querySelector("#gota-trigger");
const paymentType = document.querySelector("#payment-type");
const recipientInput = document.querySelector("#recipient-input");
const recipientList = document.querySelector("#recipient-list");
const amountOutput = document.querySelector("#amount");
const calculationDetail = document.querySelector("#calculation-detail");
const dataSourceState = document.querySelector("#data-source-state");
const dataSourceCopy = document.querySelector("#data-source-copy");
const databaseState = document.querySelector("#database-state");

let isGotaAuthorized = false;
let payoutCatalog = [];
let recipients = [];
let records = [];
let gotaAuthorizationCode = "";

function getRecords() {
  return records;
}

function setRecords(nextRecords) {
  records = Array.isArray(nextRecords) ? nextRecords : [];
}

function setDatabaseState(state, isError = false) {
  databaseState.textContent = `DATENBANK: ${state}`;
  databaseState.classList.toggle("source-error", isError);
}

function ensureDatabaseConfigured() {
  if (DATABASE_API_URL) {
    return;
  }

  setDatabaseState("NICHT KONFIGURIERT", true);
  throw new Error("Die Google-Apps-Script-Web-App ist noch nicht in app-config.js eingetragen.");
}

async function callDatabase(action, payload = {}) {
  ensureDatabaseConfigured();
  const response = await fetch(DATABASE_API_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ action, ...payload }),
  });

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error("Die Google-Apps-Script-Web-App hat keine lesbare Antwort geliefert.");
  }

  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Die Datenbankaktion ist fehlgeschlagen.");
  }

  return result;
}

async function loadRecordsFromDatabase() {
  if (!isGotaAuthorized || !gotaAuthorizationCode) {
    setRecords([]);
    renderRecords();
    return;
  }

  const result = await callDatabase("list", { password: gotaAuthorizationCode });
  setRecords(result.records);
  renderRecords();
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function createRecordId() {
  const suffix = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).toUpperCase().slice(-5);
  return `FZ-${new Date().getFullYear()}-${suffix}`;
}

function setFeedback(target, message, isError = false) {
  target.textContent = message;
  target.classList.toggle("error", isError);
}

function getRecordRecipients(record) {
  if (Array.isArray(record.recipients)) {
    return record.recipients;
  }

  return typeof record.recipient === "string" && record.recipient ? [record.recipient] : [];
}

function getRecordReferences(record) {
  if (Array.isArray(record.references)) {
    return record.references;
  }

  return typeof record.reference === "string" && record.reference ? [record.reference] : [];
}

function extractHttpLinks(text) {
  const matches = String(text ?? "").match(/https?:\/\/[^\s<>"]+/gi) ?? [];
  const uniqueLinks = new Set();

  matches.forEach((match) => {
    try {
      const url = new URL(match.replace(/[),.;]+$/, ""));
      if (url.protocol === "https:" || url.protocol === "http:") {
        uniqueLinks.add(url.href);
      }
    } catch {
      return;
    }
  });

  return [...uniqueLinks];
}

function setDataSourceState(state, copy, isError = false) {
  dataSourceState.textContent = `DATENBLATT: ${state}`;
  dataSourceCopy.textContent = copy;
  dataSourceState.classList.toggle("source-error", isError);
}

function parsePayoutAmount(value) {
  if (typeof value === "number") {
    return value;
  }

  const normalized = String(value ?? "").replace(/[^0-9,.-]/g, "").replace(/,/g, "");
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function parseDataSheet(responseText) {
  const start = responseText.indexOf("{");
  const end = responseText.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Das Datenblatt hat kein lesbares Tabellenformat geliefert.");
  }

  const table = JSON.parse(responseText.slice(start, end + 1)).table;
  return (table.rows ?? [])
    .map((row) => {
      const cells = row.c ?? [];
      const valueAt = (index) => cells[index]?.v ?? cells[index]?.f ?? "";
      const label = String(valueAt(0)).trim();
      const abbreviation = String(valueAt(1)).trim();

      return {
        id: `${label}|${abbreviation}`,
        label,
        abbreviation,
        payouts: {
          Teilnahme: parsePayoutAmount(valueAt(2)),
          "Zusatz pro Soldat": parsePayoutAmount(valueAt(3)),
          Gewonnen: parsePayoutAmount(valueAt(4)),
          Verloren: parsePayoutAmount(valueAt(5)),
        },
      };
    })
    .filter((entry) => entry.label && entry.abbreviation);
}

function populatePayoutTypes() {
  paymentType.replaceChildren(new Option("Auswaehlen", ""));
  payoutCatalog.forEach((entry) => {
    paymentType.add(new Option(`${entry.label} (${entry.abbreviation})`, entry.id));
  });
  paymentType.disabled = payoutCatalog.length === 0;
}

async function loadPayoutCatalog() {
  setDataSourceState("LADE", "SHEET / NUR LESEN");
  paymentType.disabled = true;
  paymentType.replaceChildren(new Option("Datenblatt wird geladen", ""));

  try {
    if ((await hashValue(DATA_SHEET_URL)) !== DATA_SHEET_HASH) {
      throw new Error("Die Datenquellenpruefung ist fehlgeschlagen.");
    }

    const response = await fetch(DATA_SHEET_URL, { method: "GET", cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Datenblatt nicht erreichbar (${response.status}).`);
    }

    payoutCatalog = parseDataSheet(await response.text());
    if (payoutCatalog.length === 0) {
      throw new Error("Im Datenblatt wurden keine Auszahlungsarten gefunden.");
    }

    populatePayoutTypes();
    setDataSourceState("BEREIT", `${DATA_SHEET_NAME.toUpperCase()} / NUR LESEN`);
  } catch (error) {
    payoutCatalog = [];
    setDataSourceState("NICHT ERREICHBAR", "Keine lokale Auszahlungsberechnung", true);
    setFeedback(formFeedback, error.message, true);
  }

  updateAmountPreview();
}

function getSelectedReferences() {
  return [...document.querySelectorAll('input[name="reference"]:checked')].map((input) => input.value);
}

function getSelectedPayoutType() {
  return payoutCatalog.find((entry) => entry.id === paymentType.value) ?? null;
}

function calculateAmount() {
  const selectedType = getSelectedPayoutType();
  const selectedReferences = getSelectedReferences();
  if (!selectedType || selectedReferences.length === 0) {
    return { amountPerRecipient: 0, total: 0, details: [] };
  }

  const recipientCount = recipients.length;
  const details = selectedReferences.map((reference) => {
    const sourceAmount = selectedType.payouts[reference] ?? 0;
    const multiplier = reference === "Zusatz pro Soldat" ? recipientCount : 1;
    const amountPerRecipient = sourceAmount * multiplier;
    return {
      reference,
      sourceAmount,
      multiplier,
      amountPerRecipient,
      total: amountPerRecipient * recipientCount,
    };
  });

  const amountPerRecipient = details.reduce((total, detail) => total + detail.amountPerRecipient, 0);

  return {
    amountPerRecipient,
    total: details.reduce((total, detail) => total + detail.total, 0),
    details,
  };
}

function updateAmountPreview() {
  const calculation = calculateAmount();
  amountOutput.textContent = formatCurrency(calculation.amountPerRecipient);

  if (!getSelectedPayoutType()) {
    calculationDetail.textContent = "Auszahlungsart aus Spalte A/B waehlen.";
    return;
  }

  if (calculation.details.length === 0) {
    calculationDetail.textContent = "Mindestens eine Referenz waehlen.";
    return;
  }

  const payoutBreakdown = calculation.details
    .map((detail) => detail.reference === "Zusatz pro Soldat" && recipients.length > 0
      ? `Zusatz pro Person: ${formatCurrency(detail.sourceAmount)} x ${detail.multiplier} = ${formatCurrency(detail.amountPerRecipient)} je Empfaenger`
      : `${detail.reference}: ${formatCurrency(detail.amountPerRecipient)}`)
    .join(" + ");
  calculationDetail.textContent = recipients.length > 0
    ? `${payoutBreakdown} | Einzelbetrag: ${formatCurrency(calculation.amountPerRecipient)} pro Empfaenger | ${recipients.length} Einzelvorgaenge: ${formatCurrency(calculation.total)} gesamt`
    : `${payoutBreakdown} | Einzelbetrag: ${formatCurrency(calculation.amountPerRecipient)} pro Empfaenger`;
}

function renderRecipients() {
  recipientList.replaceChildren();
  recipients.forEach((recipient) => {
    const token = document.createElement("span");
    token.className = "recipient-token";
    token.textContent = recipient;

    const removeButton = document.createElement("button");
    removeButton.className = "token-remove";
    removeButton.type = "button";
    removeButton.ariaLabel = `${recipient} entfernen`;
    removeButton.textContent = "x";
    removeButton.addEventListener("click", () => {
      recipients = recipients.filter((item) => item !== recipient);
      renderRecipients();
      updateAmountPreview();
    });

    token.append(removeButton);
    recipientList.append(token);
  });
}

function addRecipients(value) {
  const candidateNumbers = value
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const invalidNumber = candidateNumbers.find((item) => !/^[A-Za-z0-9-]{1,32}$/.test(item));
  if (invalidNumber) {
    setFeedback(formFeedback, `Reisepassnummer "${invalidNumber}" ist ungueltig.`, true);
    return false;
  }

  candidateNumbers.forEach((item) => {
    if (!recipients.includes(item)) {
      recipients.push(item);
    }
  });
  recipientInput.value = "";
  renderRecipients();
  updateAmountPreview();
  return true;
}

function updateMetrics(records) {
  const pendingRecords = records.filter((record) => record.status === "offen");
  const approvedRecords = records.filter((record) => record.status === "freigegeben");
  const pendingTotal = pendingRecords.reduce((total, record) => total + record.amount, 0);

  document.querySelector("#pending-count").textContent = pendingRecords.length;
  document.querySelector("#pending-total").textContent = formatCurrency(pendingTotal);
  document.querySelector("#approved-count").textContent = approvedRecords.length;
  document.querySelector("#sidebar-count").textContent = records.length;
}

function renderEvidence(record, evidenceCell) {
  const links = Array.isArray(record.links) ? record.links : extractHttpLinks(record.purpose);
  if (links.length === 0) {
    evidenceCell.textContent = "--";
    return;
  }

  links.forEach((link, index) => {
    const anchor = document.createElement("a");
    anchor.className = "evidence-link";
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = `LINK ${index + 1}`;
    evidenceCell.append(anchor);
  });
}

function renderRecords() {
  const records = getRecords();
  recordsBody.replaceChildren();
  emptyState.hidden = records.length > 0;

  records.forEach((record) => {
    const row = recordTemplate.content.cloneNode(true);
    row.querySelector(".record-id").textContent = record.id;
    row.querySelector(".record-recipient").textContent = getRecordRecipients(record).join(", ");
    row.querySelector(".record-type").textContent = record.paymentType;
    row.querySelector(".record-reference").textContent = getRecordReferences(record).join(" / ");
    row.querySelector(".record-amount").textContent = formatCurrency(record.amount);
    renderEvidence(record, row.querySelector(".record-evidence"));

    const status = row.querySelector(".record-status");
    const statusTag = document.createElement("span");
    statusTag.className = `status-tag ${record.status === "freigegeben" ? "status-approved" : "status-pending"}`;
    statusTag.textContent = record.status === "freigegeben" ? "FREIGEGEBEN" : "OFFEN";
    status.append(statusTag);

    const actionCell = row.querySelector(".record-action");
    if (isGotaAuthorized) {
      const actions = document.createElement("div");
      actions.className = "admin-actions";

      if (record.status === "offen") {
        const approveButton = document.createElement("button");
        approveButton.className = "approve-button";
        approveButton.type = "button";
        approveButton.textContent = "Freigeben";
        approveButton.addEventListener("click", () => approveRecord(record.id));
        actions.append(approveButton);
      }

      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-button";
      deleteButton.type = "button";
      deleteButton.ariaLabel = `Vorgang ${record.id} loeschen`;
      deleteButton.title = "Vorgang loeschen";
      const deleteIcon = document.createElement("i");
      deleteIcon.setAttribute("data-lucide", "trash-2");
      deleteIcon.setAttribute("aria-hidden", "true");
      deleteButton.append(deleteIcon);
      deleteButton.addEventListener("click", () => deleteRecord(record.id));
      actions.append(deleteButton);
      actionCell.append(actions);
    } else {
      actionCell.textContent = "GOTA";
    }

    recordsBody.append(row);
  });

  updateMetrics(records);
  lucide.createIcons();
}

async function approveRecord(recordId) {
  if (!isGotaAuthorized) {
    return;
  }

  try {
    const result = await callDatabase("approve", { recordId, password: gotaAuthorizationCode });
    setRecords(getRecords().map((record) => record.id === recordId ? result.record : record));
    renderRecords();
  } catch (error) {
    setFeedback(formFeedback, error.message, true);
  }
}

async function deleteRecord(recordId) {
  if (!isGotaAuthorized || !window.confirm(`Vorgang ${recordId} endgueltig loeschen?`)) {
    return;
  }

  try {
    await callDatabase("delete", { recordId, password: gotaAuthorizationCode });
    setRecords(getRecords().filter((record) => record.id !== recordId));
    renderRecords();
  } catch (error) {
    setFeedback(formFeedback, error.message, true);
  }
}

async function hashValue(value) {
  if (!window.crypto?.subtle) {
    throw new Error("Die Browser-Verschluesselung ist nicht verfuegbar.");
  }

  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function updateAuthorizationState() {
  securityState.textContent = isGotaAuthorized ? "GOTA AUTORISIERT" : "GOTA GESPERRT";
  securityCopy.textContent = isGotaAuthorized ? "Freigaben aktiv in dieser Sitzung" : "Freigaben nicht verfuegbar";
  document.querySelector(".security-panel svg").setAttribute("data-lucide", isGotaAuthorized ? "shield-check" : "lock-keyhole");
  gotaTrigger.querySelector("span").textContent = isGotaAuthorized ? "GOTA AKTIV" : "GOTA-ZUGANG";
  if (!isGotaAuthorized) {
    gotaAuthorizationCode = "";
    setRecords([]);
  }
  lucide.createIcons();
  renderRecords();
}

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!requestForm.checkValidity()) {
    requestForm.reportValidity();
    return;
  }

  if (!addRecipients(recipientInput.value) || recipients.length === 0) {
    setFeedback(formFeedback, "Mindestens eine Reisepassnummer erfassen.", true);
    recipientInput.focus();
    return;
  }

  const selectedReferences = getSelectedReferences();
  if (selectedReferences.length === 0) {
    setFeedback(formFeedback, "Mindestens eine Referenz auswaehlen.", true);
    return;
  }

  const selectedPayoutType = getSelectedPayoutType();
  const calculation = calculateAmount();
  if (!selectedPayoutType || calculation.amountPerRecipient <= 0) {
    setFeedback(formFeedback, "Der Auszahlungsbetrag konnte nicht aus dem Datenblatt berechnet werden.", true);
    return;
  }

  const formData = new FormData(requestForm);
  const purpose = formData.get("purpose").trim();
  const links = extractHttpLinks(purpose);
  const newRecords = recipients.map((recipient) => ({
    recipient,
    recipientCount: recipients.length,
    payoutTypeId: selectedPayoutType.id,
    references: selectedReferences,
    purpose,
    links,
  }));

  try {
    setFeedback(formFeedback, "Einzelvorgaenge werden in Google Sheets erfasst.");
    const result = await callDatabase("create", { records: newRecords });
    setRecords([...result.records, ...getRecords()]);
    requestForm.reset();
    recipients = [];
    renderRecipients();
    updateAmountPreview();
    setFeedback(formFeedback, `${result.records.length} Einzelvorgaenge wurden in Google Sheets erfasst.`);
    renderRecords();
  } catch (error) {
    setFeedback(formFeedback, error.message, true);
  }
});

recipientInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "," || event.key === ";") {
    event.preventDefault();
    addRecipients(recipientInput.value);
  }

  if (event.key === "Backspace" && !recipientInput.value && recipients.length > 0) {
    recipients.pop();
    renderRecipients();
    updateAmountPreview();
  }
});

recipientInput.addEventListener("blur", () => addRecipients(recipientInput.value));
paymentType.addEventListener("change", updateAmountPreview);
document.querySelectorAll('input[name="reference"]').forEach((input) => input.addEventListener("change", updateAmountPreview));

gotaTrigger.addEventListener("click", () => {
  if (isGotaAuthorized) {
    isGotaAuthorized = false;
    updateAuthorizationState();
    return;
  }

  authFeedback.textContent = "";
  authDialog.showModal();
  gotaPassword.focus();
});

document.querySelector("#dialog-close").addEventListener("click", () => authDialog.close());

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFeedback(authFeedback, "Zugang wird geprueft ...");

  try {
    const enteredPassword = gotaPassword.value;
    await callDatabase("authorize", { password: enteredPassword });
    isGotaAuthorized = true;
    gotaAuthorizationCode = enteredPassword;
    gotaPassword.value = "";
    authDialog.close();
    updateAuthorizationState();
    await loadRecordsFromDatabase();
  } catch (error) {
    setFeedback(authFeedback, error.message, true);
    gotaPassword.select();
  }
});

document.querySelector("#refresh-records").addEventListener("click", async () => {
  try {
    await loadRecordsFromDatabase();
  } catch (error) {
    setFeedback(formFeedback, error.message, true);
  }
  await loadPayoutCatalog();
});

document.querySelector("#current-date").textContent = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
}).format(new Date()).toUpperCase();
document.querySelector("#session-id").textContent = `SITZUNG ${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).toUpperCase()}`;

lucide.createIcons();
setDatabaseState(DATABASE_API_URL ? "KONFIGURIERT" : "NICHT KONFIGURIERT", !DATABASE_API_URL);
renderRecords();
loadPayoutCatalog();