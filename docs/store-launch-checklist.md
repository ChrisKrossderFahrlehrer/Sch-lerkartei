# Android & Windows Store – Launch-Checkliste (ADK / FahrSync)

Status: Vorbereitung. Noch nichts veröffentlicht, kein Konto angelegt.
Ausgangslage: ADK ist eine PWA unter https://fahrsync.de (`index.html`,
`manifest.json`, `sw.js`), gehostet als statische Seite mit Firebase als
Backend (Firestore/Functions/Storage). Der Weg auf Android und Windows
läuft über **PWABuilder** (https://www.pwabuilder.com) – kein eigenes
natives Projekt nötig.

Betroffen ist primär die Haupt-App "ADK – Digitale Kartei" (`manifest.json`).
Das Schüler-Portal (`manifest-portal.json`, `schueler-portal.html`) ist
separat und wird hier bewusst noch nicht mit verpackt.

## Bereits erledigt (dieser Vorbereitungsschritt)

- `manifest.json` ergänzt um `id`, `scope`, `display_override`, `dir`
  (von PWABuilder/TWA erwartete bzw. empfohlene Felder).
- `.well-known/assetlinks.json` als Platzhalter angelegt (leeres Array) –
  Erklärung in `.well-known/README.md`.

## Noch offen, bevor es an den Start geht

### 1. Icons & Assets prüfen
- [ ] Vorhandene Icons (`icon-192.png`, `icon-512.png`, `icon-maskable-*.png`)
      sind ausreichend für PWABuilder (min. 192/512, any + maskable ✓).
- [ ] Screenshots für die Store-Einträge erstellen (aktuell `screenshots: []`
      im Manifest). Empfehlung:
      - mind. 1 Smartphone-Screenshot (`form_factor: "narrow"`, z. B. 1080×1920)
      - mind. 1 Desktop/Tablet-Screenshot (`form_factor: "wide"`, z. B. 1920×1080)
      - Play Store verlangt separat mind. 2 Screenshots beim Listing-Upload
        (unabhängig vom Manifest).
- [ ] Play Store: Feature-Grafik 1024×500 px vorbereiten.
- [ ] Microsoft Store: Store-Logo 300×300 sowie mind. 1 Screenshot (1366×768
      oder ähnlich) vorbereiten.

### 2. Entwickler-Konten anlegen
- [ ] Google Play Console: einmalig 25 $, Registrierung + Identitätsprüfung
      (kann einige Tage dauern) → https://play.google.com/console
- [ ] Microsoft Partner Center: kostenlos für Einzelpersonen (Verifizierung
      per Ausweis/Firma) → https://partner.microsoft.com/dashboard

### 3. Android – Paket über PWABuilder erzeugen
- [ ] Auf pwabuilder.com die URL `https://fahrsync.de` eingeben, Manifest-
      Check laufen lassen, Warnungen beheben.
- [ ] Android-Paket generieren lassen (Trusted Web Activity, signiert).
      Dabei wird ein **Signing-Key** erzeugt/hochgeladen – sicher verwahren
      (Passwort + Keystore-Datei), er wird für jedes Update wieder gebraucht.
- [ ] Aus dem generierten Key den **SHA256-Fingerprint** entnehmen.
- [ ] `.well-known/assetlinks.json` mit echtem `package_name`
      (Vorschlag: `de.fahrsync.adk`) und dem Fingerprint befüllen, deployen,
      danach mit dem Statement-List-Generator von Google prüfen
      (siehe `.well-known/README.md`).
- [ ] Play Console: neuer Eintrag, App-Bundle (.aab) hochladen, Store-
      Listing (Kurz-/Langbeschreibung, Kategorie „Bildung“, Screenshots,
      Feature-Grafik) ausfüllen.
- [ ] **Data Safety / Datenschutz-Nährwertkennzeichnung** ausfüllen – wichtig,
      da Nutzerdaten (Fahrschüler, Termine, ggf. personenbezogene Daten) über
      Firebase verarbeitet werden. Auf bestehende `datenschutz.html` verlinken.
- [ ] Interne Testphase (Internal Testing Track) vor Produktiv-Release nutzen.

### 4. Windows – Paket über PWABuilder erzeugen
- [ ] Auf pwabuilder.com dasselbe Manifest für Windows exportieren (MSIX).
- [ ] Publisher-Infos aus dem Partner-Center-Konto eintragen (Publisher ID,
      Package Identity Name – im Partner Center unter „App-Identität“ zu
      finden, muss vor dem Build feststehen).
- [ ] MSIX-Paket lokal testen (Installation über Doppelklick/`Add-AppxPackage`)
      bevor es hochgeladen wird.
- [ ] Im Partner Center: neuer App-Eintrag, Paket hochladen, Store-Listing
      ausfüllen (Beschreibung, Screenshots, Alterseinstufung, Datenschutz-
      Link auf `datenschutz.html`).
- [ ] Zertifizierung abwarten (idR. wenige Tage).

### 5. Rechtliches / Formalia (für beide Stores)
- [ ] `datenschutz.html` und `impressum.html` müssen öffentlich unter
      fester URL erreichbar sein (sind sie bereits) – Links in beiden Store-
      Einträgen hinterlegen.
- [ ] Prüfen, ob Firebase-Datenverarbeitung (Auftragsverarbeitung, Server-
      Standort) in der Datenschutzerklärung korrekt beschrieben ist, bevor
      sie in Store-Fragebögen referenziert wird.
- [ ] Impressumspflicht beachten (App richtet sich an gewerbliche Nutzer/
      Fahrlehrer – ggf. Kontaktdaten prüfen).

### 6. Versionierung / Wartung
- [ ] Kurze Konvention festlegen, wie App-Versionsnummern (Android
      `versionCode`/`versionName`, Windows Package-Version) zur PWA-
      Versionierung (`sw.js` → `CACHE_NAME`) in Bezug stehen, damit Updates
      nachvollziehbar bleiben.

## Nicht Teil dieser Vorbereitung

- iOS/Apple (App Store) – erfordert einen nativen Wrapper (z. B. Capacitor),
  Apple Developer Program (99 $/Jahr) und in der Regel einen Mac/CI-Build.
  Wird bewusst zurückgestellt, siehe vorherige Rückmeldung im Chat.
- Verpackung des Schüler-Portals (`manifest-portal.json`) als eigene App.
