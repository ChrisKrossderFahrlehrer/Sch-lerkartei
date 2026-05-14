# 📘 ADK – Digitale Kartei: Komplette Anleitung

---

## 📦 Was du hast

Nach dem Entpacken der ZIP-Datei hast du 8 Dateien:

| Datei | Was es ist |
|---|---|
| `index.html` | Die ADK Kartei-App für Fahrlehrer |
| `adk-platform.html` | Die Verwaltungs-App (Admin + Registrierung) |
| `sw.js` | Offline-Modus |
| `manifest.json` | App-Icon und Name |
| `icon-192.png` | App-Icon klein |
| `icon-512.png` | App-Icon groß |
| `firestore.rules` | Datenschutz-Regeln (für Firebase) |
| `SETUP.md` | Technische Doku |

---

## 🚀 SCHRITT 1: Dateien auf GitHub hochladen

### Wohin?
Dein GitHub Repository:
```
github.com/ChrisKrossderFahrlehrer/Sch-lerkartei
```

### Wie?
1. Öffne dein Repository auf GitHub
2. Klicke **„Add file"** → **„Upload files"**
3. Ziehe alle **7 Dateien** rein (alle außer `SETUP.md` und `firestore.rules`):
   - `index.html`
   - `adk-platform.html`
   - `sw.js`
   - `manifest.json`
   - `icon-192.png`
   - `icon-512.png`
4. Scrolle runter → **„Commit changes"**
5. Warte 1-2 Minuten bis GitHub Pages aktualisiert

### Ergebnis
Deine App ist erreichbar unter:
- **Fahrlehrer-App:** `fahrschülerkartei.de/index.html`
- **Admin-App:** `fahrschülerkartei.de/adk-platform.html`

---

## 🔥 SCHRITT 2: Firebase einrichten

### 2a) Firestore-Regeln eintragen (WICHTIG!)

1. Gehe zu **Firebase Console** → dein Projekt `fahrschule-ebc65`
2. Linkes Menü: **„Firestore Database"** → Tab **„Rules"**
3. Du siehst aktuelle Regeln – **alles löschen**
4. Öffne die Datei `firestore.rules` mit einem Texteditor (Notepad, TextEdit)
5. **Kompletten Inhalt** kopieren (Strg+A → Strg+C)
6. In Firebase in das Regeln-Feld einfügen (Strg+V)
7. Oben rechts **„Publish"** klicken
8. Nach 30 Sekunden aktiv

### 2b) Dein Superadmin-Account

1. Firebase Console → **„Authentication"** → **„Users"**
2. Klicke **„Add user"**
3. E-Mail: `chriskoo@mail.de`
4. Passwort: **sicheres Passwort wählen** (mind. 8 Zeichen)
5. **„Add user"** klicken

### 2c) Authorized Domains

1. Firebase Console → **„Authentication"** → Tab **„Settings"**
2. Scroll runter zu **„Authorized domains"**
3. Prüfe dass diese Einträge vorhanden sind:
   - `chriskrossderfahrlehrer.github.io` (oder dein GitHub Pages Domain)
   - `fahrschülerkartei.de`
4. Falls nicht → **„Add domain"** und beide hinzufügen

---

## 👑 SCHRITT 3: Als Superadmin einloggen

1. Öffne im Browser: `fahrschülerkartei.de/adk-platform.html`
2. Tab **„Anmelden"** ist ausgewählt
3. E-Mail: `chriskoo@mail.de`
4. Passwort: (was du in Schritt 2b festgelegt hast)
5. **„Anmelden →"** klicken

**Du siehst:** 🔱 Super-Admin Dashboard mit 5 Tabs:
- ⏳ Ausstehend (neue Fahrschulen-Anfragen)
- ✅ Aktiv (freigeschaltete Fahrschulen)
- 📊 Analytics (Nutzungsstatistiken)
- 📋 Alle (alle Fahrschulen)
- ⚙️ (Einstellungen)

---

## 📝 SCHRITT 4: Plattform-Impressum eintragen

1. Als Superadmin eingeloggt → Tab **⚙️** (ganz rechts)
2. Fülle aus:
   - **Dein Name**: Chriskoo
   - **Webseite**: fahrschuelerkartei.de
   - **E-Mail**: chriskoo@mail.de
   - **Stadt/Land**: Deutschland
   - Weitere Felder optional
3. **„💾 Impressum speichern"** klicken
4. Sollte **✅ Gespeichert!** anzeigen

Wenn Fehler kommt → Schritt 2a (Firestore-Regeln) wurde nicht gemacht!

---

## 🏫 SCHRITT 5: So nutzen Fahrschulen die App

### Fahrschule registriert sich
1. Fahrschule öffnet: `fahrschülerkartei.de/adk-platform.html`
2. Tab **„Fahrschule registrieren"** klicken
3. Formular ausfüllen (Name, Inhaber, E-Mail, Passwort, Stadt)
4. **3 Checkboxen ankreuzen** (AGB, DSGVO, AVV)
5. **„Registrierung absenden →"** klicken
6. Status = **„⏳ Ausstehend"** – wartet auf dich

### Du schaltest die Fahrschule frei
1. Als Superadmin eingeloggt → Tab **⏳ Ausstehend**
2. Auf die neue Fahrschule klicken
3. **„✅ Fahrschule freischalten"** klicken
4. Fertig – die Fahrschule kann sich einloggen

### Fahrschule legt Fahrlehrer an
1. Fahrschul-Admin loggt sich ein unter `adk-platform.html`
2. Tab **👨‍🏫 Fahrlehrer**
3. Klick auf **+ Neu anlegen**
4. Fahrlehrer-Daten eingeben → **„Anlegen ✓"**

### Fahrlehrer arbeitet mit der App
1. Fahrlehrer öffnet: `fahrschülerkartei.de/index.html`
2. Loggt sich mit seinen Daten ein
3. Arbeitet normal mit der Kartei-App
4. Sieht nur Schüler seiner eigenen Fahrschule

---

## 📱 SCHRITT 6: App auf dem Handy installieren

### Android (Chrome)
1. `fahrschülerkartei.de/index.html` öffnen
2. 3 Punkte Menü oben rechts
3. **„App installieren"** oder **„Zum Startbildschirm hinzufügen"**
4. Bestätigen – ADK-Icon erscheint auf dem Homescreen

### iPhone (Safari – nicht Chrome!)
1. `fahrschülerkartei.de/index.html` in Safari öffnen
2. Teilen-Symbol unten (Quadrat mit Pfeil)
3. **„Zum Home-Bildschirm"**
4. Bestätigen

---

## ✅ Checkliste – hast du alles?

- [ ] Alle 7 Dateien auf GitHub hochgeladen
- [ ] `firestore.rules` in Firebase eingefügt und „Publish" geklickt
- [ ] Account `chriskoo@mail.de` in Firebase Authentication angelegt
- [ ] Als Superadmin eingeloggt (siehst 🔱 Dashboard)
- [ ] Plattform-Impressum im Tab ⚙️ gespeichert
- [ ] Test-Fahrschule registriert (zur Kontrolle)

---

## 🆘 Wenn etwas nicht klappt

**Problem: „Fehler beim Speichern"**
→ Firestore-Regeln nicht aktuell. Schritt 2a nochmal durchgehen.

**Problem: „Permission denied"**
→ Gleiche Ursache – Regeln in Firebase Console veröffentlichen.

**Problem: Superadmin-Dashboard erscheint nicht nach Login**
→ Prüfe dass die E-Mail `chriskoo@mail.de` in Firebase Authentication angelegt wurde.

**Problem: Fahrlehrer-Login funktioniert nicht**
→ Fahrlehrer muss in `users`-Collection in Firestore existieren. Wird automatisch angelegt wenn du über das Admin-Panel einen Fahrlehrer erstellst.

**Problem: Cache-Probleme (alte Version wird angezeigt)**
→ Browser Cache löschen oder im Inkognito-Modus öffnen

---

## 💡 Wichtige URLs

| Was | URL |
|---|---|
| Fahrlehrer App | `fahrschülerkartei.de/index.html` |
| Admin & Registrierung | `fahrschülerkartei.de/adk-platform.html` |
| GitHub Repository | `github.com/ChrisKrossderFahrlehrer/Sch-lerkartei` |
| Firebase Console | `console.firebase.google.com` |

---

**Viel Erfolg mit der App! 🚀**

Bei Fragen: @ChrisKrossderFahrlehrer auf Instagram
