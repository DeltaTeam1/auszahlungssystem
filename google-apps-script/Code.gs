const SPREADSHEET_ID = '13IjN7-7c9iwyciluIfDZNfCHFl7TlOMoHP8l00n77_E';
const DATA_SHEET_NAME = 'data_auszahlung';
const PENDING_SHEET_NAME = 'erfasst';
const PAID_SHEET_NAME = 'ausgezahlt';
const GOTA_PASSWORD_HASH_PROPERTY = 'GOTA_PASSWORD_HASH';
const PAYOUT_REFERENCES = ['Teilnahme', 'Zusatz pro Soldat', 'Gewonnen', 'Verloren'];
const RECORD_HEADERS = [
  'Vorgangs-ID',
  'Reisepassnummer',
  'Auszahlungsart',
  'Referenzen',
  'Empfaengeranzahl',
  'Betrag USD',
  'Verwendungszweck',
  'Nachweislinks',
  'Status',
  'Erfasst am',
  'Freigegeben am',
];

function doGet() {
  return json_({
    ok: true,
    service: 'Feldzahlstelle Datenbank',
    protectedSheets: [DATA_SHEET_NAME],
  });
}

function doPost(event) {
  try {
    const request = parseRequest_(event);
    return json_(dispatchRequest_(request));
  } catch (error) {
    console.error(error);
    return json_({ ok: false, error: error.message || 'Unbekannter Serverfehler.' });
  }
}

function setupDatabase() {
  const database = openDatabase_();
  return {
    pendingSheet: database.pending.getName(),
    paidSheet: database.paid.getName(),
    protectedSheet: database.data.getName(),
  };
}

function dispatchRequest_(request) {
  switch (request.action) {
    case 'create':
      return createRecords_(request.records);
    case 'authorize':
      assertAuthorized_(request.password);
      return { ok: true };
    case 'list':
      assertAuthorized_(request.password);
      return { ok: true, records: listRecords_() };
    case 'approve':
      assertAuthorized_(request.password);
      return { ok: true, record: approveRecord_(request.recordId) };
    case 'delete':
      assertAuthorized_(request.password);
      deleteRecord_(request.recordId);
      return { ok: true };
    default:
      throw new Error('Unbekannte Datenbankaktion.');
  }
}

function createRecords_(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
    throw new Error('Es muss mindestens ein und duerfen maximal 100 Vorgaenge gesendet werden.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const database = openDatabase_();
    const catalog = readPayoutCatalog_(database.data);
    const createdAt = new Date();
    const normalizedRecords = records.map((record) => normalizeNewRecord_(record, catalog, createdAt));
    const rows = normalizedRecords.map(recordToRow_);
    const startRow = database.pending.getLastRow() + 1;
    database.pending.getRange(startRow, 1, rows.length, RECORD_HEADERS.length).setValues(rows);
    database.pending.getRange(startRow, 6, rows.length, 1).setNumberFormat('$#,##0.00');
    database.pending.getRange(startRow, 10, rows.length, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    SpreadsheetApp.flush();
    return { ok: true, records: normalizedRecords };
  } finally {
    lock.releaseLock();
  }
}

function approveRecord_(recordId) {
  const id = requiredString_(recordId, 'Vorgangs-ID');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const database = openDatabase_();
    const sourceRow = findRecordRow_(database.pending, id);
    if (!sourceRow) {
      throw new Error('Der offene Vorgang wurde nicht gefunden.');
    }

    const values = database.pending.getRange(sourceRow, 1, 1, RECORD_HEADERS.length).getValues()[0];
    values[8] = 'AUSGEZAHLT';
    values[10] = new Date();
    database.paid.appendRow(values);
    const destinationRow = database.paid.getLastRow();
    database.paid.getRange(destinationRow, 6).setNumberFormat('$#,##0.00');
    database.paid.getRange(destinationRow, 10, 1, 2).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    database.pending.deleteRow(sourceRow);
    SpreadsheetApp.flush();
    return rowToRecord_(values, 'freigegeben');
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord_(recordId) {
  const id = requiredString_(recordId, 'Vorgangs-ID');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const database = openDatabase_();
    const pendingRow = findRecordRow_(database.pending, id);
    if (pendingRow) {
      database.pending.deleteRow(pendingRow);
      return;
    }

    const paidRow = findRecordRow_(database.paid, id);
    if (paidRow) {
      database.paid.deleteRow(paidRow);
      return;
    }

    throw new Error('Der Vorgang wurde nicht gefunden.');
  } finally {
    lock.releaseLock();
  }
}

function listRecords_() {
  const database = openDatabase_();
  return readSheetRecords_(database.pending, 'offen').concat(readSheetRecords_(database.paid, 'freigegeben'));
}

function openDatabase_() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const data = spreadsheet.getSheetByName(DATA_SHEET_NAME);
  if (!data) {
    throw new Error(`Das geschuetzte Tabellenblatt "${DATA_SHEET_NAME}" wurde nicht gefunden.`);
  }

  return {
    data,
    pending: ensureManagedSheet_(spreadsheet, PENDING_SHEET_NAME),
    paid: ensureManagedSheet_(spreadsheet, PAID_SHEET_NAME),
  };
}

function ensureManagedSheet_(spreadsheet, name) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const actualHeaders = sheet.getRange(1, 1, 1, RECORD_HEADERS.length).getDisplayValues()[0];
  if (actualHeaders.join('|') !== RECORD_HEADERS.join('|')) {
    throw new Error(`Das Tabellenblatt "${name}" hat nicht die erwarteten Spalten.`);
  }

  return sheet;
}

function readPayoutCatalog_(dataSheet) {
  const rows = dataSheet.getDataRange().getValues();
  if (rows.length < 2) {
    throw new Error('Das Tabellenblatt data_auszahlung enthaelt keine Auszahlungsdaten.');
  }

  const catalog = {};
  rows.slice(1).forEach(row => {
    const label = String(row[0] || '').trim();
    const abbreviation = String(row[1] || '').trim();
    if (!label || !abbreviation) {
      return;
    }

    catalog[`${label}|${abbreviation}`] = {
      label,
      abbreviation,
      payouts: {
        Teilnahme: parseAmount_(row[2]),
        'Zusatz pro Soldat': parseAmount_(row[3]),
        Gewonnen: parseAmount_(row[4]),
        Verloren: parseAmount_(row[5]),
      },
    };
  });

  return catalog;
}

function normalizeNewRecord_(record, catalog, createdAt) {
  if (!record || typeof record !== 'object') {
    throw new Error('Ein Vorgang hat ein ungueltiges Format.');
  }

  const recipient = requiredString_(record.recipient, 'Reisepassnummer');
  if (!/^[A-Za-z0-9-]{1,32}$/.test(recipient)) {
    throw new Error(`Die Reisepassnummer "${recipient}" ist ungueltig.`);
  }

  const recipientCount = Number(record.recipientCount);
  if (!Number.isInteger(recipientCount) || recipientCount < 1 || recipientCount > 100) {
    throw new Error('Die Empfaengeranzahl ist ungueltig.');
  }

  const payoutType = catalog[requiredString_(record.payoutTypeId, 'Auszahlungsart')];
  if (!payoutType) {
    throw new Error('Die Auszahlungsart wurde nicht im Datenblatt data_auszahlung gefunden.');
  }

  const references = normalizeReferences_(record.references);
  const amount = references.reduce((total, reference) => {
    const multiplier = reference === 'Zusatz pro Soldat' ? recipientCount : 1;
    return total + payoutType.payouts[reference] * multiplier;
  }, 0);
  if (amount <= 0) {
    throw new Error('Der Auszahlungsbetrag ist ungueltig.');
  }

  const purpose = requiredString_(record.purpose, 'Verwendungszweck');
  const links = normalizeLinks_(record.links);
  return {
    id: createRecordId_(),
    recipient,
    recipients: [recipient],
    recipientCount,
    amount,
    paymentType: `${payoutType.label} (${payoutType.abbreviation})`,
    references,
    purpose,
    links,
    status: 'offen',
    createdAt: createdAt.toISOString(),
    approvedAt: null,
  };
}

function recordToRow_(record) {
  return [
    record.id,
    record.recipient,
    record.paymentType,
    record.references.join(' | '),
    record.recipientCount,
    record.amount,
    record.purpose,
    record.links.join('\n'),
    'OFFEN',
    new Date(record.createdAt),
    '',
  ];
}

function readSheetRecords_(sheet, status) {
  if (sheet.getLastRow() < 2) {
    return [];
  }

  return sheet.getRange(2, 1, sheet.getLastRow() - 1, RECORD_HEADERS.length)
    .getValues()
    .map(row => rowToRecord_(row, status));
}

function rowToRecord_(row, status) {
  const createdAt = toIsoString_(row[9]);
  const approvedAt = toIsoString_(row[10]);
  return {
    id: String(row[0]),
    recipient: String(row[1]),
    recipients: [String(row[1])],
    paymentType: String(row[2]),
    references: String(row[3] || '').split(' | ').filter(Boolean),
    recipientCount: Number(row[4]) || 1,
    amount: Number(row[5]) || 0,
    purpose: String(row[6] || ''),
    links: String(row[7] || '').split('\n').filter(Boolean),
    status,
    createdAt,
    approvedAt,
  };
}

function findRecordRow_(sheet, recordId) {
  if (sheet.getLastRow() < 2) {
    return null;
  }

  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues().flat();
  const index = ids.indexOf(recordId);
  return index === -1 ? null : index + 2;
}

function normalizeReferences_(references) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error('Mindestens eine Referenz muss ausgewaehlt sein.');
  }

  const normalized = [...new Set(references.map(reference => String(reference).trim()))];
  if (normalized.some(reference => !PAYOUT_REFERENCES.includes(reference))) {
    throw new Error('Eine Referenz ist ungueltig.');
  }

  return normalized;
}

function normalizeLinks_(links) {
  if (!Array.isArray(links)) {
    return [];
  }

  return [...new Set(links.map(link => String(link).trim()).filter(Boolean))].map(link => {
    if (!/^https?:\/\/\S+$/i.test(link)) {
      throw new Error('Ein Nachweislink muss mit http:// oder https:// beginnen.');
    }
    return link;
  });
}

function assertAuthorized_(password) {
  const expectedHash = PropertiesService.getScriptProperties().getProperty(GOTA_PASSWORD_HASH_PROPERTY);
  if (!expectedHash) {
    throw new Error('Der GOTA-Passwort-Hash ist nicht in den Script Properties konfiguriert.');
  }

  const receivedHash = sha256_(requiredString_(password, 'GOTA-Passwort'));
  if (receivedHash !== expectedHash.toLowerCase()) {
    throw new Error('GOTA-Autorisierung abgelehnt.');
  }
}

function sha256_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(byte => (`0${(byte & 0xff).toString(16)}`).slice(-2))
    .join('');
}

function createRecordId_() {
  return `FZ-${new Date().getFullYear()}-${Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function requiredString_(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} fehlt.`);
  }
  return text;
}

function parseAmount_(value) {
  if (typeof value === 'number') {
    return value;
  }

  const normalized = String(value || '').replace(/[^0-9,.-]/g, '').replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function toIsoString_(value) {
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value.toISOString() : null;
}

function parseRequest_(event) {
  if (!event || !event.postData || !event.postData.contents) {
    throw new Error('Die Anfrage enthaelt keine Daten.');
  }

  const request = JSON.parse(event.postData.contents);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Die Anfrage hat ein ungueltiges Format.');
  }
  return request;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}