# ADK Platform – Setup Anleitung

## Dateien
- `adk-platform.html` → Verwaltungs-App (Superadmin + Fahrschul-Admin Login)
- `index.html` → ADK Kartei-App (Fahrlehrer)
- `firestore.rules` → Datenschutz-Sicherheitsregeln
- `sw.js` → Offline-Modus
- `manifest.json` → PWA App-Konfiguration

---

## Schritt 1: Superadmin einrichten

1. Öffne `adk-platform.html` im Browser
2. Melde dich mit der E-Mail `admin@adk-kartei.de` an
   - Erstelle diesen Account zuerst in der Firebase Console:
     Authentication → Users → Add user
   - E-Mail: `admin@adk-kartei.de`
   - Passwort: (sicheres Passwort wählen)

3. Nach dem Login siehst du die SuperAdmin-Ansicht
4. Kopiere deine UID aus der Firebase Console
5. Ersetze in `adk-platform.html` diese Zeile:
   ```
   const SUPERADMIN_UID = 'DEINE_SUPERADMIN_UID';
   ```
   mit deiner echten UID.

---

## Schritt 2: Firestore Sicherheitsregeln einrichten

1. Firebase Console → Firestore → Rules
2. Kopiere den Inhalt von `firestore.rules` hinein
3. "Publish" klicken

**WICHTIG:** Diese Regeln sind der Kern des Datenschutzes!
Jede Fahrschule sieht NUR ihre eigenen Daten.

---

## Schritt 3: Auf GitHub Pages hochladen

Alle Dateien in ein GitHub Repository:
- `adk-platform.html` (Verwaltungs-App)
- `index.html` (ADK Kartei-App)
- `sw.js`
- `manifest.json`
- `icon-192.png`
- `icon-512.png`
- `firestore.rules` (nur zur Dokumentation, nicht aktiv)

---

## Wie eine Fahrschule sich registriert

1. Fahrschule öffnet `adk-platform.html`
2. Klickt auf "Fahrschule registrieren"
3. Füllt das Formular aus
4. **Du** siehst die Anfrage im SuperAdmin-Dashboard
5. Du schaltest die Fahrschule frei → Status: "aktiv"
6. Fahrschul-Admin kann sich nun anmelden und Fahrlehrer anlegen

---

## Wie ein Fahrlehrer arbeitet

1. Fahrlehrer erhält E-Mail + Passwort vom Fahrschul-Admin
2. Meldet sich in `adk-platform.html` an
3. Wird automatisch zu `index.html` (ADK Kartei) weitergeleitet
4. Arbeitet normal mit der Kartei-App

---

## Datenschutz-Garantien (technisch)

✅ Jeder Schüler hat eine `fahrschuleId` – Firestore erlaubt nur Zugriff
   wenn die `fahrschuleId` des Users übereinstimmt

✅ Ein Fahrlehrer von Fahrschule A kann NICHT auf Daten von Fahrschule B
   zugreifen – auch wenn er die URL kennt

✅ Firestore-Regeln sind serverseitig – können nicht umgangen werden

✅ Superadmin sieht nur Metadaten der Fahrschulen (Name, Status)
   – KEINE Schülerdaten

---

## Empfohlene Preisgestaltung

| Paket | Preis | Fahrlehrer |
|---|---|---|
| Starter | 9€/Monat | bis 2 Fahrlehrer |
| Pro | 19€/Monat | bis 5 Fahrlehrer |
| Team | 39€/Monat | unbegrenzt |

Abrechnung über Stripe oder PayPal möglich (später nachrüsten).
