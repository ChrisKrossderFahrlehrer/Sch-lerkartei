#!/usr/bin/env python3
"""Zusatzzeichen (StVO Anlage 1-3, "Zusatzzeichen") fuer den Zeichen-Katalog.

Warum gezeichnet statt heruntergeladen: Fuer die uebrigen Katalogbilder gibt
es fertige Vorlagen; fuer Zusatzzeichen mit frei waehlbarem Text (Zeiten,
Verkehrsarten) nicht in der Form, in der sie hier gebraucht werden. Ein
Zusatzzeichen ist aber genau definiert und schlicht: weisses Schild,
schwarzer Rand, schwarze Schrift. Das laesst sich originalgetreu zeichnen.

Seitenverhaeltnisse wie bei den echten Schildern: einzeilig 1,8 : 1
(420 x 231 mm), zweizeilig 4 : 3 (420 x 315 mm), dreizeilig quadratisch.

Schrift: Die amtliche Schrift ist DIN 1451. Hier wird "Barlow Semi
Condensed" verwendet (SIL Open Font License), die ihr im Schriftbild nahe
kommt. Die Schrift wird nur zum Zeichnen geladen und NICHT mit ausgeliefert -
ausgeliefert werden nur die fertigen Bilder.

Aufruf (nur noetig, wenn ein Zeichen dazukommt oder sich aendert):
    python3 werkzeug/zusatzzeichen-zeichnen.py
Ergebnis: verkehrszeichen-katalog/zz-*.jpg

Wer hier ein Zeichen ergaenzt, traegt es auch in ZEICHEN_KATALOG ein - in
index.html UND schueler-portal.html (tests/statisch.test.mjs vergleicht
beide und prueft, dass jedes Bild existiert).
"""
import os
import tempfile
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ZIEL = os.path.join(os.path.dirname(__file__), '..', 'verkehrszeichen-katalog')
SCHRIFT_URL = ('https://raw.githubusercontent.com/google/fonts/main/ofl/'
               'barlowsemicondensed/BarlowSemiCondensed-Medium.ttf')

# Dateiname (ohne .jpg) -> Zeilen auf dem Schild.
# Die Namen im Katalog stehen in ZEICHEN_KATALOG (index.html).
ZEICHEN = {
    'zz-16-18-h':            ['16–18 h'],
    'zz-8-11-16-18-h':       ['8–11 h', '16–18 h'],
    'zz-22-6-h':             ['22–6 h'],
    'zz-werktags':           ['werktags'],
    'zz-werktags-18-19-h':   ['werktags', '18–19 h'],
    'zz-mo-fr-16-18-h':      ['Mo–Fr', '16–18 h'],
    'zz-mo-fr-sa':           ['Mo–Fr 7–18 h', 'Sa 8–13 h'],
    'zz-parkscheibe-2-std':  ['mit Parkscheibe', '2 Std.'],
    'zz-anlieger-frei':      ['Anlieger frei'],
    'zz-lieferverkehr-frei': ['Lieferverkehr', 'frei'],
    'zz-bewohner':           ['Bewohner mit', 'Parkausweis', 'Nr. 5 frei'],
    'zz-taxi-frei':          ['Taxi frei'],
    'zz-auf-2-km':           ['auf 2 km'],
    'zz-200-m':              ['200 m'],
    'zz-bei-naesse':         ['bei Nässe'],
    'zz-ende':               ['Ende'],
}

# Ausgabegroesse: Breite fest, Hoehe nach Zeilenzahl.
BREITE = 300
HOEHE = {1: round(BREITE * 231 / 420), 2: round(BREITE * 315 / 420), 3: BREITE}
HINTERGRUND = (251, 251, 251)   # wie die uebrigen Katalogbilder
FAKTOR = 4                      # erst groesser zeichnen, dann verkleinern


def schrift_laden():
    pfad = os.path.join(tempfile.gettempdir(), 'BarlowSemiCondensed-Medium.ttf')
    if not os.path.exists(pfad):
        with urllib.request.urlopen(SCHRIFT_URL, timeout=30) as r, open(pfad, 'wb') as f:
            f.write(r.read())
    return pfad


def zeichne(zeilen, schriftpfad):
    w, h = BREITE * FAKTOR, HOEHE[len(zeilen)] * FAKTOR
    bild = Image.new('RGB', (w, h), HINTERGRUND)
    d = ImageDraw.Draw(bild)
    rand = round(w * 0.012)            # schmaler weisser Aussenrand
    strich = round(w * 0.022)          # schwarzer Rand
    radius = round(w * 0.035)
    d.rounded_rectangle([rand, rand, w - rand - 1, h - rand - 1],
                        radius=radius, fill=(0, 0, 0))
    innen = rand + strich
    d.rounded_rectangle([innen, innen, w - innen - 1, h - innen - 1],
                        radius=max(1, radius - strich), fill=(255, 255, 255))

    # Groesste Schrift, bei der alle Zeilen in die Innenflaeche passen.
    nutz_b = (w - 2 * innen) * 0.86
    nutz_h = (h - 2 * innen) * 0.80
    groesse = 400
    while groesse > 10:
        schrift = ImageFont.truetype(schriftpfad, groesse)
        boxen = [d.textbbox((0, 0), z, font=schrift) for z in zeilen]
        zeilenhoehe = groesse * 1.12
        breiteste = max(b[2] - b[0] for b in boxen)
        if breiteste <= nutz_b and zeilenhoehe * len(zeilen) <= nutz_h:
            break
        groesse -= 4
    # Einzeilige Kurztexte nicht riesig werden lassen (echte Schilder haben
    # eine feste Schrifthoehe, kurze Texte stehen mit viel Rand).
    groesse = min(groesse, round((h - 2 * innen) * (0.52 if len(zeilen) == 1 else 0.40)))
    schrift = ImageFont.truetype(schriftpfad, groesse)
    zeilenhoehe = groesse * 1.12
    gesamt = zeilenhoehe * len(zeilen)
    y = (h - gesamt) / 2
    for z in zeilen:
        b = d.textbbox((0, 0), z, font=schrift, anchor='ls')
        x = (w - (b[2] - b[0])) / 2 - b[0]
        d.text((x, y + zeilenhoehe * 0.80), z, font=schrift, fill=(0, 0, 0), anchor='ls')
        y += zeilenhoehe
    return bild.resize((BREITE, HOEHE[len(zeilen)]), Image.LANCZOS)


def main():
    schriftpfad = schrift_laden()
    for name, zeilen in ZEICHEN.items():
        zeichne(zeilen, schriftpfad).save(
            os.path.join(ZIEL, name + '.jpg'), quality=90, optimize=True)
    print(f'{len(ZEICHEN)} Zusatzzeichen gezeichnet')


if __name__ == '__main__':
    main()
