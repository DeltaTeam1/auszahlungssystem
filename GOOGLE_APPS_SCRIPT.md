# Google-Sheets-Datenbank einrichten

Die Anwendung nutzt drei Tabellenblaetter im vorhandenen Spreadsheet:

- `data_auszahlung`: nur lesen, niemals durch das Script veraendert
- `erfasst`: offene Auszahlungen
- `ausgezahlt`: durch GOTA freigegebene Auszahlungen

## 1. Apps Script anlegen

1. Oeffne das Google Spreadsheet.
2. Waehle `Erweiterungen` > `Apps Script`.
3. Ersetze den Inhalt von `Code.gs` vollstaendig durch den Inhalt von [google-apps-script/Code.gs](google-apps-script/Code.gs).
4. Speichere das Projekt.
5. Oeffne links `Projekteinstellungen` und lege unter `Script Properties` die Property `GOTA_PASSWORD_HASH` an.
6. Setze ihren Wert auf `0b155a8e953642f2ef3e82781ad19b6b128ea5e77cbd2f841053c46d36529bd4`.
7. Waehle im Funktionsmenue `setupDatabase` und klicke `Ausfuehren`.
8. Bestaetige die Google-Berechtigungen. Dabei werden bei Bedarf nur die Blaetter `erfasst` und `ausgezahlt` angelegt.

## 2. Web-App bereitstellen

1. Klicke `Bereitstellen` > `Neue Bereitstellung`.
2. Waehle als Typ `Web-App`.
3. Setze `Ausfuehren als` auf `Ich`.
4. Setze den Zugriff auf `Jeder` bzw. `Jeder mit Google-Konto`, falls dein Google-Konto keine anonyme Freigabe erlaubt.
5. Klicke `Bereitstellen` und kopiere die URL, die auf `/exec` endet.
6. Trage sie in [app-config.js](app-config.js) ein:

```js
window.APP_CONFIG = window.APP_CONFIG ?? {
  googleAppsScriptUrl: 'https://script.google.com/macros/s/DEINE_DEPLOYMENT_ID/exec',
};
```

7. Aktualisiere die lokale Anwendung.

Jede neue Auszahlung wird danach in `erfasst` gespeichert. Nach einer GOTA-Freigabe wird die einzelne Zeile aus `erfasst` entfernt und mit Freigabezeitpunkt in `ausgezahlt` eingefuegt. GOTA-Loeschungen werden ebenfalls serverseitig ausgefuehrt.

## Hinweise

- Nach einer Aenderung am Apps Script musst du ueber `Bereitstellen` > `Bereitstellungen verwalten` eine neue Version bereitstellen.
- Die App uebermittelt das GOTA-Passwort ausschliesslich per HTTPS an die Web-App. Die Web-App prueft es ausschliesslich gegen den serverseitig gespeicherten SHA-256-Hash.
- Die Liste der Auszahlungen ist erst nach erfolgreicher GOTA-Autorisierung vom Server lesbar.