assetlinks.json ist aktuell ein leeres Array (Platzhalter). Diese Datei verknüpft die
Android-App (TWA) kryptografisch mit der Domain fahrsync.de, damit im Play-Store-Build
keine Browser-Adressleiste angezeigt wird.

Sie kann erst final ausgefüllt werden, sobald über PWABuilder/Android Studio ein
Signing-Key für die Android-App erzeugt wurde. Siehe docs/store-launch-checklist.md,
Abschnitt "Android – Digital Asset Links", für die genauen Schritte.

Zielformat (Beispiel, Werte müssen ersetzt werden):

[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "de.fahrsync.adk",
      "sha256_cert_fingerprints": ["DEIN:SHA256:FINGERPRINT:..."]
    }
  }
]

Nach dem Ausfüllen prüfen unter:
https://developers.google.com/digital-asset-links/tools/generator
