#!/usr/bin/env python3
"""Schriften von Google Fonts EINMALIG herunterladen und lokal ablegen.

Warum: Bisher luden sechs Seiten ihre Schriften bei jedem Aufruf direkt von
fonts.googleapis.com / fonts.gstatic.com. Dabei geht die IP-Adresse jedes
Besuchers an Google - ohne Einwilligung. Das LG Muenchen I hat genau das
2022 als Verstoss gegen die DSGVO gewertet (Az. 3 O 17493/20); danach
folgte eine Abmahnwelle. Lokal ausgeliefert verlaesst keine Anfrage mehr
die eigene Seite.

Alle Schriften stehen unter der SIL Open Font License 1.1, die das
Weitergeben und Selbst-Ausliefern ausdruecklich erlaubt. Die Lizenztexte
werden mit abgelegt (schriften/LIZENZEN/).

Aufruf (nur noetig, wenn eine Schrift dazukommt):
    python3 werkzeug/schriften-holen.py
Ergebnis: schriften/*.woff2, schriften/schriften.css, schriften/LIZENZEN/
"""
import os
import re
import urllib.request

ZIEL = os.path.join(os.path.dirname(__file__), '..', 'schriften')

# Alles, was die Seiten verwenden, in einer Anfrage. Syne, Manrope und
# DM Sans sind variable Schriften: EINE Datei deckt alle Staerken ab.
URL = ('https://fonts.googleapis.com/css2'
       '?family=Syne:wght@400;600;700;800'
       '&family=Manrope:wght@300;400;500;600;700;800'
       '&family=DM+Serif+Display:ital@0;1'
       '&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600'
       '&family=JetBrains+Mono:wght@400;500;700'
       '&display=swap')

# Nur Lateinisch (Deutsch) und die Erweiterung (Namen wie "Łukasz", "Çelik").
# Griechisch, Kyrillisch, Vietnamesisch braucht hier niemand.
BEHALTEN = {'latin', 'latin-ext'}

LIZENZEN = {
    'Syne': 'syne', 'Manrope': 'manrope', 'DM Serif Display': 'dmserifdisplay',
    'DM Sans': 'dmsans', 'JetBrains Mono': 'jetbrainsmono',
}

# Ein aktueller Browser-Kennzeichner, sonst liefert Google aeltere Formate.
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')


def holen(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main():
    os.makedirs(os.path.join(ZIEL, 'LIZENZEN'), exist_ok=True)
    css = holen(URL).decode('utf-8')
    bloecke = re.findall(r'/\* ([\w-]+) \*/\s*(@font-face\s*\{.*?\})', css, re.S)
    ausgabe = ['/* Lokal ausgelieferte Schriften - erzeugt von werkzeug/schriften-holen.py.',
               '   Keine Anfrage an Google: siehe Begruendung dort.',
               '   Lizenz: SIL Open Font License 1.1, Texte in LIZENZEN/. */', '']
    geladen = {}
    for teil, block in bloecke:
        if teil not in BEHALTEN:
            continue
        quelle = re.search(r'url\((https://fonts\.gstatic\.com/[^)]+)\)', block).group(1)
        familie = re.search(r"font-family:\s*'([^']+)'", block).group(1)
        if quelle not in geladen:
            name = re.sub(r'[^a-z0-9]+', '-', familie.lower()).strip('-')
            name = f'{name}-{teil}-{len(geladen) + 1}.woff2'
            with open(os.path.join(ZIEL, name), 'wb') as f:
                f.write(holen(quelle))
            geladen[quelle] = name
        ausgabe.append(f'/* {familie}, {teil} */')
        ausgabe.append(block.replace(quelle, './' + geladen[quelle]))
    with open(os.path.join(ZIEL, 'schriften.css'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(ausgabe) + '\n')
    for familie, ordner in LIZENZEN.items():
        text = holen(f'https://raw.githubusercontent.com/google/fonts/main/ofl/{ordner}/OFL.txt')
        with open(os.path.join(ZIEL, 'LIZENZEN', f'{ordner}-OFL.txt'), 'wb') as f:
            f.write(text)
    print(f'{len(geladen)} Dateien, {sum(1 for t, _ in bloecke if t in BEHALTEN)} Schnitte')


if __name__ == '__main__':
    main()
