# Automatisch prüfen und deployen

Der Ablauf in `pruefen-und-deployen.yml` nimmt das Deployen von Hand ab:
Merge-Knopf auf github.com antippen genügt, auch vom Telefon. Kein Terminal,
kein Mac.

## Was passiert wann

| Wann | Was |
|---|---|
| Bei jedem Pull Request | Die vollständige Testsuite läuft. Ergebnis steht als ✅ oder ❌ am PR – man sieht vor dem Mergen, ob der Stand in Ordnung ist. |
| Beim Merge in `main` | Erst die Tests, dann das Deployen. **Ein roter Test verhindert das Deployen.** |
| Von Hand | Über *Actions → Prüfen und Deployen → Run workflow → main*. Deployt dann alles. Auf einem anderen Branch gestartet wird nur geprüft, nie deployt. |

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
   | **Cloud Scheduler-Administrator** | für `taeglichesAufraeumen` – der nächtliche Job ist ein Scheduler-Auftrag |
   | **Eventarc-Administrator** | für die 5 Firestore-Auslöser (neue Anfrage, neue Nachricht, Buchungszähler …) |
   | **Service Usage-Nutzer** *(Service Usage Consumer)* | `firebase deploy` prüft vorab, ob die nötigen Dienste eingeschaltet sind |

   Die letzten drei standen in einer früheren Fassung dieser Liste **nicht** –
   nachgesehen an den Auslösern in `functions/index.js`: 1× `onSchedule`,
   5× `onDocumentCreated`/`onDocumentUpdated`. Ohne sie wäre der erste echte
   Deploy genau dort gescheitert.

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

## Webhooks einrichten

Gekündigte Abos laufen 14 Tage nach und gehen dann auf Free. Davon erfährt
das Backend nur, wenn PayPal und Stripe die Kündigung auch melden. Der
Ablauf *Webhooks einrichten* schaltet die nötigen Ereignisse ein:

- PayPal: `BILLING.SUBSCRIPTION.CANCELLED`, `…SUSPENDED`, `…EXPIRED`,
  `…ACTIVATED`, `…RE-ACTIVATED`
- Stripe: `customer.subscription.deleted`, `customer.subscription.updated`

Er **fügt nur hinzu**. Schon eingeschaltete Ereignisse, die Adresse und die
Signatur bleiben unverändert.

*Actions → Webhooks einrichten → Run workflow → main*

1. Erst mit **nur-pruefen**: Das Protokoll zeigt, was eingeschaltet ist und
   was fehlt. Es wird nichts geändert.
2. Dann mit **einrichten**.

Die Zugangsdaten für PayPal und Stripe liest der Ablauf aus dem Secret
Manager des Projekts – dieselben, die die Functions benutzen. Dafür braucht
das Dienstkonto zusätzlich die Rolle **Secret Manager-Zugriffsberechtigter**
*(Secret Manager Secret Accessor)*. Fehlt sie, sagt das Protokoll genau das.
Nach dem Einrichten kann die Rolle wieder entfernt werden.
