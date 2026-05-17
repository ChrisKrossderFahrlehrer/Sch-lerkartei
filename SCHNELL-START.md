# ⚡ SCHNELL-ANLEITUNG – ADK Deployment

## 📦 DATEIEN HOCHLADEN

### 🌐 Webserver / GitHub Pages:
```
✓ index.html
✓ adk-platform.html
✓ sw.js
✓ manifest.json
✓ icon-192.png
✓ icon-512.png
```

### 🔥 Firebase Console:
```
1. https://console.firebase.google.com öffnen
2. Projekt "fahrschule-ebc65" wählen
3. Firestore Database → Rules
4. Inhalt von "firestore.rules" einfügen
5. PUBLISH klicken
```

---

## ✅ NACH DEM HOCHLADEN

### 1. Als Fahrlehrer einloggen
```
→ Auto-Migration läuft automatisch!
→ Toast: "✅ 3 Code(s) aktualisiert"
```

### 2. Konsole prüfen (F12)
```
[MIGRATION] Prüfe AccessCodes...
[MIGRATION] ✓ Code repariert: ABC123 → Max Mustermann
[MIGRATION] ✅ Erfolgreich: 3 Codes repariert
```

### 3. Schüler-Code testen
```
→ Inkognito-Fenster öffnen
→ Tab "Schüler"
→ Code eingeben
→ FUNKTIONIERT! ✅
```

---

## 🎯 DAS WAR'S!

Die Migration läuft **automatisch** - du musst **nichts** tun!

**Alle 3 Codes funktionieren nach dem ersten Login wieder.**
