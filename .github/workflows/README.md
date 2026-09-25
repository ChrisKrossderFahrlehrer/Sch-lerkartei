# Automatisch prüfen und deployen

Der Ablauf in `pruefen-und-deployen.yml` nimmt das Deployen von Hand ab:
Merge-Knopf auf github.com antippen genügt, auch vom Telefon. Kein Terminal,
kein Mac.

## Was passiert wann

| Wann | Was |
|---|---|
| Bei jedem Pull Request | Die vollständige Testsuite läuft. Ergebnis steht als ✅ oder ❌ am PR – man sieht vor dem Mergen, ob der Stand in Ordnung ist. |
| Beim Merge in `main` | Erst die Tests, dann das Deployen. **Ein roter Test verhindert das Deployen.** |
| Von Hand | Über *Actions → Prüfen und Deployen → Run workflow*. Deployt dann alles. |

Deployt wird nur, was sich geändert hat:

- `functions/**` → `--only functions`
- `firestore.rules` → `--only firestore:rules`
- `firestore.indexes.json` → `--only firestore:indexes`
- `storage.rules` → `--only storage`

Ändert sich nur die Oberfläche (`index.html`, Bilder, Tests), läuft das
Deployen gar nicht erst an – diese Dateien gehen weiterhin allein über
GitHub Pages.

## Einmalige Einrichtung

Das muss einmal am Mac gemacht werden, danach nie wieder.

### 1. Dienstkonto anlegen

1. **console.cloud.google.com** → Projekt `fahrschule-ebc65`
2. *IAM und Verwaltung → Dienstkonten → Dienstkonto erstellen*
3. Name z. B. `github-deploy`
4. Diese Rollen vergeben:

   | Rolle | wofür |
   |---|---|
   | Firebase Admin | Regeln und Indizes veröffentlichen |
   | Cloud Functions Admin | Functions anlegen und aktualisieren |
   | Cloud Run Admin | v2-Functions laufen als Cloud Run |
   | Dienstkontonutzer *(Service Account User)* | damit die Function unter ihrem eigenen Konto starten darf |
   | Cloud Build-Bearbeiter *(Cloud Build Editor)* | Functions werden beim Deployen gebaut |
   | Artifact Registry-Administrator | dort landen die gebauten Abbilder |

5. Beim fertigen Dienstkonto: *Schlüssel → Schlüssel hinzufügen → Neuen
   Schlüssel erstellen → **JSON*** → die Datei wird heruntergeladen

> Falls beim ersten Lauf trotzdem eine Berechtigung fehlt: Die Fehlermeldung
> im Actions-Protokoll **nennt die fehlende Rolle beim Namen**. Dann einfach
> ergänzen und den Lauf wiederholen. Googles Rollennamen ändern sich
> gelegentlich – die Liste oben ist der Stand bei der Einrichtung.

### 2. Schlüssel als GitHub-Secret hinterlegen

1. Im Repo: *Settings → Secrets and variables → Actions → New repository secret*
2. Name: **`FIREBASE_SERVICE_ACCOUNT`** (genau so geschrieben)
3. Wert: den **kompletten Inhalt** der heruntergeladenen JSON-Datei
   hineinkopieren, von `{` bis `}`

### 3. Heruntergeladene Datei löschen

Die JSON-Datei ist ein vollwertiger Schlüssel zum Projekt. Nach dem
Einfügen ins Secret gehört sie vom Rechner gelöscht – auch aus dem
Papierkorb.

## Prüfen, ob es geht

*Actions → Prüfen und Deployen → Run workflow → main*

Läuft der Durchgang grün durch, ist alles eingerichtet. Ab dann genügt der
Merge-Knopf.

## Wenn etwas schiefgeht

Der Schlüssel wird über eine Umgebungsvariable in eine Datei geschrieben und
am Ende wieder gelöscht – er steht nie in der Kommandozeile und taucht
deshalb nicht in Protokollen oder Prozesslisten auf. GitHub schwärzt
Secrets in den Protokollen zusätzlich.

Zwei Deploys gleichzeitig sind ausgeschlossen (`concurrency`), und ein
laufendes Deploy wird **nicht** abgebrochen – das könnte die Functions halb
aktualisiert zurücklassen.

Soll ein Schlüssel ungültig gemacht werden: In der Cloud Console beim
Dienstkonto den Schlüssel löschen, einen neuen erzeugen und das GitHub-Secret
ersetzen.
