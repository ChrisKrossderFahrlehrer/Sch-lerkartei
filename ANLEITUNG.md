# 🚀 ADK – Digitale Kartei – DEPLOYMENT ANLEITUNG

## ✅ NEU: Automatische Code-Migration

**Die App repariert jetzt automatisch alle alten Zugangscodes beim ersten Login!**

---

## 📦 WAS HOCHLADEN?

### 🌐 **AUF WEBSERVER / GITHUB PAGES:**

Lade folgende Dateien in das **ROOT-Verzeichnis** deiner Website:

```
✓ index.html              ← Haupt-App (Fahrlehrer + Schüler)
✓ adk-platform.html       ← SuperAdmin Panel
✓ sw.js                   ← Service Worker (PWA/Offline)
✓ manifest.json           ← App-Manifest (PWA)
✓ icon-192.png            ← App-Icon klein
✓ icon-512.png            ← App-Icon groß
✓ ANLEITUNG.md            ← Diese Datei (optional)
```

**Beispiel GitHub Pages:**
```
https://deinusername.github.io/adk/index.html
https://deinusername.github.io/adk/adk-platform.html
```

**Beispiel eigener Server:**
```
https://deine-domain.de/index.html
https://deine-domain.de/adk-platform.html
```

---

### 🔥 **IN FIREBASE CONSOLE:**

1. **Firestore Rules deployen:**
   - Gehe zu: https://console.firebase.google.com
   - Projekt: `fahrschule-ebc65` auswählen
   - Links: **Firestore Database** → **Rules** Tab
   - Kopiere den kompletten Inhalt aus `firestore.rules`
   - Klicke **Publish** (Veröffentlichen)

**WICHTIG:** Ohne korrekte Rules funktioniert die Schüler-Ansicht nicht!

---

## 🎯 ERSTE SCHRITTE NACH DEPLOYMENT

### 1️⃣ **Als Fahrlehrer einloggen**

1. Öffne `index.html` in deinem Browser
2. Logge dich mit deinem Account ein
3. **Die App migriert jetzt automatisch alle alten Codes!**
4. Du siehst eine Toast-Nachricht: `✅ X Code(s) aktualisiert`

### 2️⃣ **Migration überprüfen**

Öffne die Browser-Konsole (F12 → Console):

```
[MIGRATION] Prüfe AccessCodes auf fehlende Snapshots...
[MIGRATION] Repariere Code: ABC123 für Student: xyz...
[MIGRATION] ✓ Code repariert: ABC123 → Max Mustermann
[MIGRATION] ✅ Erfolgreich: 3 Codes repariert
```

### 3️⃣ **Schüler-Codes testen**

1. Öffne `index.html` in einem **Inkognito-Fenster**
2. Tab: **Schüler** auswählen
3. Zugangscode eingeben
4. **Es sollte jetzt funktionieren!** ✅

---

## 🔄 WIE FUNKTIONIERT DIE AUTO-MIGRATION?

Die App prüft beim **ersten Login** eines Fahrlehrers:

1. **Gibt es Codes ohne `studentSnapshot`?**
2. **Falls ja:** 
   - Lädt Schüler-Daten aus Firestore
   - Lädt Protokoll-Einträge
   - Speichert beides als Snapshot im Code-Dokument
3. **Markiert Migration als erledigt** (einmalig pro User)

**Die Migration läuft:**
- Automatisch im Hintergrund
- Nur einmal pro Fahrlehrer
- Ohne dass du etwas tun musst

---

## 🆕 NEUE CODES GENERIEREN (Optional)

Falls die Auto-Migration aus irgendeinem Grund fehlschlägt:

1. Als Fahrlehrer einloggen
2. Schüler öffnen
3. ⚙️ **Optionen** → 🔑 **Code generieren**
4. Neuen Code an Schüler weitergeben

**Neue Codes haben immer Snapshots!**

---

## 📱 PWA INSTALLATION (Progressive Web App)

Nach dem Hochladen können Nutzer die App installieren:

**Auf Android/Chrome:**
1. `index.html` öffnen
2. Menü (⋮) → "Zum Startbildschirm hinzufügen"
3. App öffnet sich wie native App

**Auf iPhone/Safari:**
1. `index.html` öffnen
2. Teilen-Button → "Zum Home-Bildschirm"
3. App läuft im Vollbild

---

## 🛠️ TROUBLESHOOTING

### ❌ **"Dieser Code ist veraltet"**

**Ursache:** Migration ist noch nicht gelaufen oder fehlgeschlagen

**Lösung:**
1. Als Fahrlehrer neu einloggen (Migration läuft)
2. Oder: Neuen Code manuell generieren

---

### ❌ **Schüler-Ansicht zeigt "undefined"**

**Ursache:** Firestore Rules nicht deployed oder Code hat keinen Snapshot

**Lösung:**
1. Firestore Rules prüfen (Firebase Console)
2. Browser-Cache leeren: `Ctrl+Shift+R`
3. Code neu generieren

---

### ❌ **Migration läuft nicht**

**Debug:**
1. Browser-Konsole öffnen (F12)
2. Nach `[MIGRATION]` suchen
3. Fehler kopieren und analysieren

**Mögliche Ursachen:**
- Firestore Permissions fehlen
- Offline (keine Internetverbindung)
- Student-Dokument wurde gelöscht

---

## 📊 FIREBASE PROJEKT-INFO

```
Projekt-ID:      fahrschule-ebc65
Region:          europe-west (Frankfurt)
Firestore:       Native Mode
Authentication:  Email/Password enabled
```

---

## ✨ NEUE FEATURES IN DIESER VERSION

✅ **Auto-Migration für alte Codes**
- Läuft automatisch beim ersten Login
- Repariert alle Codes ohne Snapshot
- Einmalig pro Fahrlehrer

✅ **Verbesserte Fehlerbehandlung**
- Detaillierte Console-Logs
- Klare Fehlermeldungen für Schüler
- Erkennung alter Codes

✅ **Performance-Optimierung**
- Migration nur einmal pro User
- Async-Loading aller Daten
- Keine redundanten Firestore-Queries

---

## 📞 SUPPORT

Bei Problemen:
1. Browser-Konsole (F12) öffnen
2. Alle `[MIGRATION]` und `[FEHLER]` Nachrichten kopieren
3. Screenshot erstellen
4. Fehler analysieren

---

## 🎉 FERTIG!

Nach dem Hochladen sollte alles funktionieren:

1. ✅ Fahrlehrer-Login
2. ✅ Auto-Migration läuft
3. ✅ Schüler-Codes funktionieren
4. ✅ PWA-Installation möglich
5. ✅ Offline-Modus aktiv

**Viel Erfolg mit ADK – Digitale Kartei! 🚗**
