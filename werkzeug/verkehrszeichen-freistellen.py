# Stellt ein Katalog-Zeichen frei: Das Weiss AUSSEN wird durchsichtig, das
# Weiss INNEN (STOP-Schrift, weisses Dreieck bei "Vorfahrt gewaehren",
# Zifferblatt bei Tempo-Schildern) bleibt stehen.
#
# Deshalb kein "alle weissen Pixel loeschen", sondern eine Fuellung von den
# Bildraendern her: Was von aussen erreichbar ist, ist Hintergrund - alles
# andere gehoert zum Schild, egal wie hell es ist.
from PIL import Image
from collections import deque
import sys, os

HELL = 233        # ab hier gilt ein Pixel als Hintergrundweiss
RAND = 246        # fast reinweisse Randpixel weich ausblenden

def freistellen(quelle, ziel, kante=128):
    im = Image.open(quelle).convert('RGB')
    w, h = im.size
    px = im.load()
    hg = bytearray(w * h)          # 1 = Hintergrund

    def weiss(p):
        return p[0] >= HELL and p[1] >= HELL and p[2] >= HELL

    schlange = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not hg[y*w+x] and weiss(px[x, y]): hg[y*w+x] = 1; schlange.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not hg[y*w+x] and weiss(px[x, y]): hg[y*w+x] = 1; schlange.append((x, y))

    while schlange:
        x, y = schlange.popleft()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h and not hg[ny*w+nx] and weiss(px[nx, ny]):
                hg[ny*w+nx] = 1
                schlange.append((nx, ny))

    # Alphakanal. Pixel am Uebergang sind durch die JPEG-Kompression
    # aufgehellt - wuerden sie voll deckend bleiben, saehe man einen weissen
    # Saum um jedes Schild. Sie bekommen deshalb ein abgestuftes Alpha.
    aus = Image.new('RGBA', (w, h))
    ap = aus.load()
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if hg[y*w+x]:
                ap[x, y] = (255, 255, 255, 0)
                continue
            amRand = any(0 <= x+dx < w and 0 <= y+dy < h and hg[(y+dy)*w + x+dx]
                         for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)))
            a = 255
            if amRand:
                hellste = max(p)
                if hellste > RAND:   a = 0
                elif hellste > HELL: a = int(255 * (RAND - hellste) / (RAND - HELL))
            ap[x, y] = (p[0], p[1], p[2], a)

    aus.thumbnail((kante, kante), Image.LANCZOS)
    aus.save(ziel, 'PNG', optimize=True)
    return aus.size, os.path.getsize(ziel)

if __name__ == '__main__':
    for n in sys.argv[2:]:
        groesse, bytes_ = freistellen(f'verkehrszeichen-katalog/{n}.jpg',
                                      os.path.join(sys.argv[1], f'{n}.png'))
        print(f'  {n:<8} {groesse[0]}x{groesse[1]}  {bytes_/1024:.1f} KB')
