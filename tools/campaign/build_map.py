"""Builds the campaign map rasters from Natural Earth coastlines (public domain) and hand-placed relief.

Usage:
  node tools/campaign/extract_land.mjs > /tmp/land.json   (needs world-atlas + topojson-client)
  python3 tools/campaign/build_map.py /tmp/land.json

Outputs in public/campaign/:
  terrain.png  R,G = height (16 bit, 0 = deepest sea, 32768 = sea level), B = dryness
  regions.png  R = province index (255 = none), G = river strength, B = 0
  map.json     size, projection, settlement pixels, ports, province adjacency
"""
import heapq
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
WORLD = json.load(open(os.path.join(ROOT, 'src', 'campaign', 'world.json')))
OUT = os.path.join(ROOT, 'public', 'campaign')

BB = WORLD['bbox']
W = 1024
COS0 = math.cos(math.radians(BB['lat0']))
K = W / ((BB['lonMax'] - BB['lonMin']) * COS0)  # pixels per degree of latitude
H = int(round((BB['latMax'] - BB['latMin']) * K))


def proj(lon, lat, scale=1.0):
    return ((lon - BB['lonMin']) * COS0 * K * scale, (BB['latMax'] - lat) * K * scale)


# ----------------------------------------------------------------------------- relief
# (points as lon/lat, peak height 0-1, half width in degrees)
RIDGES = [
    ([(5.6, 44.0), (6.6, 45.0), (6.9, 45.9), (8.0, 46.3), (10.0, 46.5), (12.0, 46.9), (14.0, 47.2), (16.0, 47.6)], 1.0, 0.9),
    ([(-1.8, 43.1), (0.5, 42.7), (2.8, 42.5)], 0.8, 0.45),
    ([(8.4, 44.4), (10.5, 44.2), (12.4, 43.4), (13.5, 42.3), (14.8, 41.2), (15.8, 40.3), (16.2, 39.0), (16.0, 38.3)], 0.5, 0.55),
    ([(14.5, 45.6), (16.5, 44.1), (18.5, 43.0), (19.8, 42.0), (20.6, 40.8), (21.3, 39.5), (21.9, 38.6)], 0.6, 0.8),
    ([(22.4, 43.4), (25.0, 42.8), (27.5, 42.7)], 0.55, 0.45),
    ([(23.3, 41.7), (25.5, 41.4)], 0.5, 0.45),
    ([(17.5, 48.6), (20.0, 49.3), (23.0, 48.6), (25.4, 47.5), (25.9, 45.8), (23.5, 45.4), (22.2, 44.8)], 0.6, 0.75),
    ([(29.5, 37.0), (32.0, 36.8), (34.5, 37.3), (37.0, 37.8), (40.0, 38.4), (43.0, 38.4)], 0.75, 0.9),
    ([(31.0, 41.0), (35.0, 40.9), (39.0, 40.6), (42.0, 41.2)], 0.55, 0.6),
    ([(37.5, 44.4), (40.0, 43.3), (43.5, 42.6), (46.8, 41.4)], 1.0, 0.6),
    ([(43.2, 37.3), (44.8, 36.6), (46.0, 35.0), (47.5, 33.2)], 0.8, 0.8),
    ([(35.6, 33.0), (36.3, 34.6), (36.6, 36.0)], 0.45, 0.35),
    ([(-9.6, 30.6), (-6.0, 31.4), (-3.0, 32.6), (0.0, 33.6), (3.0, 35.4), (6.5, 35.8), (9.0, 35.8)], 0.75, 0.85),
    ([(-1.0, 36.0), (3.5, 36.4), (7.0, 36.6), (9.0, 36.8)], 0.4, 0.45),
    ([(-5.6, 35.1), (-3.6, 35.0)], 0.5, 0.35),
    ([(-7.2, 40.3), (-3.6, 40.8)], 0.5, 0.45),
    ([(-5.4, 36.7), (-3.0, 37.1), (-1.2, 38.0)], 0.55, 0.45),
    ([(-7.5, 43.0), (-3.5, 43.1)], 0.55, 0.4),
    ([(-3.0, 41.9), (-1.2, 40.6), (-0.6, 39.9)], 0.45, 0.5),
    ([(5.8, 47.2), (7.2, 47.7), (8.3, 48.0)], 0.35, 0.35),
    ([(33.5, 26.5), (35.0, 23.5)], 0.35, 0.45),
    ([(36.4, 28.5), (38.0, 25.0)], 0.45, 0.5),
    ([(-5.0, 57.3), (-3.5, 56.8)], 0.45, 0.6),
    ([(-3.8, 52.0), (-3.6, 53.0)], 0.35, 0.45),
    ([(-2.2, 54.0), (-2.4, 55.0)], 0.3, 0.35),
]
BLOBS = [
    (3.0, 45.2, 0.45, 1.1), (-4.0, 40.0, 0.28, 3.2), (33.0, 39.0, 0.32, 4.0), (42.0, 39.5, 0.65, 2.6),
    (9.0, 42.15, 0.5, 0.55), (9.1, 40.1, 0.35, 0.55), (14.3, 37.8, 0.35, 0.6), (15.0, 37.75, 0.55, 0.25),
    (24.9, 35.2, 0.45, 0.45), (32.9, 34.95, 0.35, 0.35), (13.5, 49.5, 0.35, 1.4), (10.5, 51.0, 0.25, 1.4),
    (22.2, 37.5, 0.4, 0.6), (21.8, 32.6, 0.25, 0.5), (34.0, 28.8, 0.5, 0.7), (24.5, 46.0, 0.35, 1.1),
    (11.5, 47.6, 0.3, 1.2), (20.5, 41.5, 0.45, 1.0), (19.5, 47.9, 0.25, 0.5), (26.2, 38.3, 0.2, 2.0),
    (36.5, 31.0, 0.3, 1.2), (-6.0, 31.0, 0.55, 1.0), (1.5, 33.0, 0.25, 2.0),
]
RIVERS = [
    [(31.25, 30.1), (31.0, 28.0), (31.3, 27.0), (32.5, 25.8), (32.9, 24.1)],
    [(31.2, 30.1), (30.4, 31.0), (30.35, 31.45)], [(31.2, 30.1), (31.6, 31.0), (31.85, 31.5)],
    [(38.5, 38.5), (38.3, 36.6), (39.4, 35.9), (40.5, 34.6), (42.0, 34.0), (43.5, 32.6), (46.0, 31.0), (47.2, 30.6)],
    [(40.5, 37.9), (42.5, 37.0), (43.1, 36.3), (44.4, 33.3), (45.5, 32.3), (46.9, 31.2)],
    [(8.5, 48.0), (12.0, 48.8), (14.3, 48.3), (16.4, 48.2), (18.9, 47.8), (19.0, 45.5), (20.5, 44.8), (22.5, 44.2),
     (25.0, 43.7), (27.5, 44.1), (28.0, 45.3), (29.6, 45.2)],
    [(9.5, 47.6), (8.2, 48.9), (8.3, 50.0), (7.1, 50.7), (6.3, 51.8), (4.5, 51.9)],
    [(6.1, 46.2), (4.8, 45.75), (4.8, 44.2), (4.6, 43.4)],
    [(7.6, 45.0), (9.2, 45.1), (10.5, 45.0), (12.3, 44.95)],
    [(12.2, 43.3), (12.5, 42.5), (12.25, 41.75)],
    [(-3.8, 42.9), (-1.5, 41.9), (0.5, 41.0), (0.85, 40.7)],
    [(-1.7, 40.3), (-4.0, 39.9), (-6.5, 39.6), (-9.0, 38.75)],
    [(-3.0, 38.1), (-5.9, 37.4), (-6.3, 36.85)],
    [(4.0, 46.0), (2.0, 47.5), (0.0, 47.3), (-2.1, 47.3)],
    [(4.5, 48.0), (2.4, 48.8), (0.2, 49.4)],
    [(1.0, 43.2), (0.5, 44.3), (-0.6, 45.0)],
    [(-1.5, 51.7), (0.5, 51.5)],
    [(34.5, 40.0), (35.8, 41.7)],
    [(24.5, 42.2), (26.0, 41.8), (26.2, 40.8)],
    [(11.0, 50.5), (12.0, 51.5), (11.7, 52.6), (10.0, 53.6), (8.7, 53.9)],
    [(14.5, 51.0), (14.6, 52.5), (14.3, 53.9)],
    [(21.0, 48.2), (20.2, 46.2)],
    [(25.0, 47.8), (28.1, 45.5)],
    [(26.5, 49.3), (28.5, 48.3), (30.0, 47.0), (30.5, 46.4)],
    [(33.0, 48.5), (35.0, 47.8), (34.0, 46.8), (32.5, 46.5)],
    [(39.0, 49.2), (40.5, 48.0), (39.4, 47.2)],
]
DESERTS = [  # polygons (lon, lat) of hot desert, before the Nile and Mesopotamia carve their strips back
    [(-12, 24), (-12, 29.2), (-8.5, 30.0), (-4, 31.5), (0.5, 33.3), (5.0, 34.0), (8.0, 33.4), (10.2, 33.4), (11.5, 32.6),
     (13.0, 31.8), (15.5, 31.0), (19.5, 30.6), (20.5, 31.8), (23.0, 32.0), (25.0, 31.5), (29.0, 30.6), (33.0, 30.6),
     (35.0, 31.2), (36.5, 32.6), (38.5, 34.8), (41.0, 35.6), (44.0, 34.8), (47, 33.6), (47, 24)],
]


def lonlat_line(points, scale):
    return [proj(lo, la, scale) for lo, la in points]


def fbm(shape, seed, octaves=6, base=8):
    rng = np.random.default_rng(seed)
    out = np.zeros(shape, dtype=np.float64)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        g = rng.random((int(n * shape[0] / shape[1]) + 2, n + 2))
        z = ndimage.zoom(g, (shape[0] / (g.shape[0] - 1), shape[1] / (g.shape[1] - 1)), order=3)[: shape[0], : shape[1]]
        out += z * amp
        total += amp
        amp *= 0.5
    return out / total


def ridged(shape, seed, octaves=6, base=10):
    """Ridged multifractal noise: sharp crests and valleys for mountain ranges."""
    rng = np.random.default_rng(seed)
    out = np.zeros(shape, dtype=np.float64)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        g = rng.random((int(n * shape[0] / shape[1]) + 2, n + 2))
        z = ndimage.zoom(g, (shape[0] / (g.shape[0] - 1), shape[1] / (g.shape[1] - 1)), order=3)[: shape[0], : shape[1]]
        out += (1 - np.abs(z * 2 - 1)) ** 2 * amp
        total += amp
        amp *= 0.55
    return out / total


def main(land_path):
    polys = json.load(open(land_path))
    S = 2  # supersampling for a smooth coastline
    img = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(img)
    for poly in polys:
        outer = lonlat_line(poly[0], S)
        d.polygon(outer, fill=255)
        for hole in poly[1:]:
            d.polygon(lonlat_line(hole, S), fill=0)
    land_f = np.asarray(img.resize((W, H), Image.BOX), dtype=np.float64) / 255.0
    land = land_f > 0.5

    # Distance to coast, inland and out to sea (pixels).
    dist_in = ndimage.distance_transform_edt(land)
    dist_out = ndimage.distance_transform_edt(~land)

    # Relief.
    hgt = 0.035 + 0.09 * (1 - np.exp(-dist_in / 22.0))
    ridge_field = np.zeros((H, W))
    for pts, peak, width in RIDGES:
        im = Image.new('L', (W, H), 0)
        ImageDraw.Draw(im).line(lonlat_line(pts, 1), fill=255, width=1)
        dd = ndimage.distance_transform_edt(np.asarray(im) == 0)
        wpx = width * K
        ridge_field = np.maximum(ridge_field, peak * np.exp(-(dd / wpx) ** 2))
    blob_field = np.zeros((H, W))
    yy, xx = np.mgrid[0:H, 0:W]
    for lo, la, peak, r in BLOBS:
        cx, cy = proj(lo, la)
        rr = r * K
        blob_field = np.maximum(blob_field, peak * np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (rr * rr))))
    n1 = fbm((H, W), 1, 7, 6)
    rg = ridged((H, W), 2, 6, 12)
    mountains = ridge_field * (0.25 + 1.05 * rg) + blob_field * (0.45 + 0.8 * rg * n1 * 1.4)
    hills = 0.10 * np.clip(n1 - 0.45, 0, 1) * 3 + 0.05 * rg * np.clip(1 - dist_out * 0, 0, 1)
    hgt = hgt + mountains * 0.95 + hills
    # Keep low-lying coasts low near the shore so cities sit by the water.
    hgt *= np.clip(dist_in / 3.0, 0.25, 1.0)

    # Rivers: carve shallow valleys and keep their strength for the shader.
    river = np.zeros((H, W))
    for pts in RIVERS:
        im = Image.new('L', (W, H), 0)
        ImageDraw.Draw(im).line(lonlat_line(pts, 1), fill=255, width=1)
        dd = ndimage.distance_transform_edt(np.asarray(im) == 0)
        river = np.maximum(river, np.exp(-(dd / 1.3) ** 2))
    river *= land
    hgt *= 1 - 0.35 * river

    sea_depth = np.clip(dist_out / 40.0, 0, 1) ** 0.6
    height = np.where(land, hgt, -0.02 - 0.5 * sea_depth)
    height = ndimage.gaussian_filter(height, 0.7)
    # 16-bit encode: sea level at 32768, 1.0 = 32767 units up.
    enc = np.clip(np.round(32768 + height * 30000), 0, 65535).astype(np.uint32)


    # Dryness 0 (lush) .. 1 (desert).
    lat = BB['latMax'] - yy / K
    dry = np.clip((44.0 - lat) / 14.0, 0, 1) * 0.55
    im = Image.new('L', (W, H), 0)
    for poly in DESERTS:
        ImageDraw.Draw(im).polygon(lonlat_line(poly, 1), fill=255)
    desert = ndimage.gaussian_filter(np.asarray(im, dtype=np.float64) / 255.0, 6)
    dry = np.maximum(dry, desert)
    # Rivers in the desert make green strips (Nile, Euphrates, Tigris).
    green = ndimage.gaussian_filter(river, 1.6) * 3.0
    dry = np.clip(dry - green, 0, 1)
    dry = np.clip(dry + (n1 - 0.5) * 0.25, 0, 1)
    terrain = np.zeros((H, W, 3), dtype=np.uint8)
    terrain[..., 0] = enc >> 8
    terrain[..., 1] = enc & 255
    terrain[..., 2] = np.round(dry * 255).astype(np.uint8)

    # Settlements: snap to land.
    st = WORLD['settlements']
    idx_x, idx_y = ndimage.distance_transform_edt(~land, return_distances=False, return_indices=True)
    pix = []
    for s in st:
        x, y = proj(s['lon'], s['lat'])
        xi, yi = int(round(x)), int(round(y))
        xi, yi = min(W - 1, max(0, xi)), min(H - 1, max(0, yi))
        if not land[yi, xi]:
            yi, xi = int(idx_x[yi, xi]), int(idx_y[yi, xi])
        pix.append((xi, yi))

    # Provinces: grow every settlement over land; mountains, rivers and distance cost more.
    slope = np.hypot(*np.gradient(hgt))
    cost = 1.0 + slope * 120 + river * 4 + mountains * 3 + desert * 2.5
    owner = np.full((H, W), 255, dtype=np.uint8)
    best = np.full((H, W), np.inf)
    heap = []
    for i, (x, y) in enumerate(pix):
        best[y, x] = 0
        heapq.heappush(heap, (0.0, i, x, y))
    LIMIT = 170.0
    nb = [(-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0), (-1, -1, 1.414), (1, 1, 1.414), (-1, 1, 1.414), (1, -1, 1.414)]
    while heap:
        c, i, x, y = heapq.heappop(heap)
        if c > best[y, x] or owner[y, x] != 255:
            continue
        owner[y, x] = i
        for dx, dy, f in nb:
            nx, ny = x + dx, y + dy
            if 0 <= nx < W and 0 <= ny < H and land[ny, nx] and owner[ny, nx] == 255:
                nc = c + f * cost[ny, nx]
                if nc < best[ny, nx] and nc < LIMIT:
                    best[ny, nx] = nc
                    heapq.heappush(heap, (nc, i, nx, ny))
    # Islands and leftovers: nearest owned pixel if it is close.
    unowned = land & (owner == 255)
    if unowned.any():
        dist, (iy, ix) = ndimage.distance_transform_edt(owner == 255, return_indices=True)
        fill = unowned & (dist < 30)
        owner[fill] = owner[iy[fill], ix[fill]]
    owner[~land] = 255

    # Adjacency by shared borders.
    adj = set()
    for a, b in ((owner[:, :-1], owner[:, 1:]), (owner[:-1, :], owner[1:, :])):
        m = (a != b) & (a != 255) & (b != 255)
        for p, q in zip(a[m].tolist(), b[m].tolist()):
            adj.add((min(p, q), max(p, q)))
    # Ports: settlements within 3 px of the sea.
    ports = [bool(dist_in[y, x] <= 3.5) for x, y in pix]
    areas = np.bincount(owner[owner != 255].ravel(), minlength=len(st)).tolist()

    # Smooth province borders at 3x for drawing: blur each province mask and keep the strongest.
    S3 = 3
    img3 = Image.new('L', (W * S3, H * S3), 0)
    d3 = ImageDraw.Draw(img3)
    for poly in polys:
        d3.polygon(lonlat_line(poly[0], S3), fill=255)
        for hole in poly[1:]:
            d3.polygon(lonlat_line(hole, S3), fill=0)
    land3 = np.asarray(img3) > 127
    up = np.repeat(np.repeat(owner, S3, 0), S3, 1)
    best3 = np.full(up.shape, -1.0, dtype=np.float32)
    lab3 = np.full(up.shape, 255, dtype=np.uint8)
    for i in list(range(len(st))) + [255]:
        ys, xs = np.nonzero(owner == i)
        if not len(ys):
            continue
        y0, y1 = max(0, (ys.min() - 3) * S3), min(H * S3, (ys.max() + 4) * S3)
        x0, x1 = max(0, (xs.min() - 3) * S3), min(W * S3, (xs.max() + 4) * S3)
        m = ndimage.gaussian_filter((up[y0:y1, x0:x1] == i).astype(np.float32), 2.2)
        sel = m > best3[y0:y1, x0:x1]
        best3[y0:y1, x0:x1][sel] = m[sel]
        lab3[y0:y1, x0:x1][sel] = i
    lab3[~land3] = 255
    hi = np.zeros((H * S3, W * S3, 3), dtype=np.uint8)
    hi[..., 0] = lab3
    hi[..., 1] = lab3
    hi[..., 2] = lab3

    regions = np.zeros((H, W, 3), dtype=np.uint8)
    regions[..., 0] = owner
    regions[..., 1] = np.round(np.clip(river, 0, 1) * 255).astype(np.uint8)
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(terrain, 'RGB').save(os.path.join(OUT, 'terrain.png'), optimize=True)
    Image.fromarray(regions, 'RGB').save(os.path.join(OUT, 'regions.png'), optimize=True)
    Image.fromarray(hi[..., 0], 'L').save(os.path.join(OUT, 'borders.png'), optimize=True)
    meta = dict(
        width=W, height=H, k=K, cos0=COS0, bbox=BB,
        settlements=[dict(id=s['id'], x=x, y=y, port=p, area=a) for s, (x, y), p, a in zip(st, pix, ports, areas)],
        adjacency=sorted([list(e) for e in adj]),
    )
    json.dump(meta, open(os.path.join(OUT, 'map.json'), 'w'))
    # Preview for checking.
    prev = np.zeros((H, W, 3), dtype=np.uint8)
    prev[~land] = (40, 70, 120)
    v = np.clip(hgt / 0.9, 0, 1)
    dryc = dry[..., None]
    lush = np.array([70, 110, 50]) * (1 - dryc) + np.array([200, 180, 120]) * dryc
    col = lush * (1 - v[..., None]) + np.array([235, 235, 235]) * v[..., None]
    prev[land] = col[land].astype(np.uint8)
    edge = np.zeros((H, W), bool)
    edge[:, 1:] |= owner[:, 1:] != owner[:, :-1]
    edge[1:, :] |= owner[1:, :] != owner[:-1, :]
    prev[edge & land] = (20, 20, 20)
    prev[river > 0.5] = (60, 100, 160)
    pim = Image.fromarray(prev)
    dr = ImageDraw.Draw(pim)
    for (x, y), s in zip(pix, st):
        dr.rectangle([x - 2, y - 2, x + 2, y + 2], fill=(200, 30, 30))
    os.makedirs(os.path.join(ROOT, 'shots'), exist_ok=True)
    pim.save(os.path.join(ROOT, 'shots', 'campaign-map-preview.png'))
    print(f'{W}x{H}, {len(st)} settlements, {len(adj)} borders, {sum(ports)} ports')


if __name__ == '__main__':
    main(sys.argv[1])
