"""Convert a few 0 A.D. trees (CC BY-SA 3.0, Wildfire Games) into a compact format for the battle map.

Usage: python3 tools/assets/zeroad_trees.py /path/to/0ad/binaries/data/mods/public/art

Output: public/trees/trees.json + trees.bin + one PNG per texture.
trees.bin holds, for every part, float32 vertices (pos xyz, normal xyz, uv) then uint32 indices.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import zeroad_units as Z  # noqa: E402

ART = Z.ART
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'trees')

# kind -> variants; each variant is a list of (mesh, texture, attach) parts.
# attach: None, or (mesh of the parent part, prop point name) for canopies sitting on a trunk.
KINDS = {
    'pine': dict(height=11.0, variants=[
        [('gaia/tree_pine_aleppo_1.dae', 'gaia/aleppo_pine.dds', None)],
        [('gaia/tree_pine_aleppo_2.dae', 'gaia/aleppo_pine.dds', None)],
        [('gaia/tree_pine_aleppo_4.dae', 'gaia/aleppo_pine.dds', None)],
    ]),
    'cypress': dict(height=12.0, variants=[
        [('gaia/cypress_mediterranean_wild.dae', 'gaia/tree_cypress_a.png', None)],
        [('gaia/cypress_mediterranean_wild_2.dae', 'gaia/tree_cypress_c.png', None)],
        [('gaia/cypress_mediterranean_wild_4.dae', 'gaia/tree_cypress_a.png', None)],
    ]),
    'beech': dict(height=13.0, variants=[
        [('gaia/tree_oak_a.dae', 'gaia/trunk_beech_a.dds', None),
         ('gaia/tree_oak_top_a.dae', 'gaia/tree_euro_beech_a.dds', ('gaia/tree_oak_a.dae', 'tree'))],
        [('gaia/tree_oak_b.dae', 'gaia/trunk_beech_a.dds', None),
         ('gaia/tree_oak_top_b.dae', 'gaia/tree_euro_beech_a.dds', ('gaia/tree_oak_b.dae', 'tree'))],
    ]),
}


def mesh_parts(rel, base=np.eye(4)):
    """All static geometry in a COLLADA file, already placed by its node transforms, in Z-up."""
    d = Z.Dae(os.path.join(ART, 'meshes', rel))
    W = d.rest_world()
    out = []
    for ni, n in enumerate(d.nodes):
        inst = n['el'].find(Z.NS + 'instance_geometry')
        if inst is None:
            continue
        gid = inst.get('url')[1:]
        if gid not in d.geoms:
            continue
        pos, cp, cn, cuv = Z.read_geometry(d.geoms[gid])
        M = base @ W[ni]
        p = np.c_[pos[cp], np.ones(len(cp))] @ M.T
        nrm = cn @ np.linalg.inv(M[:3, :3]).T
        out.append((p[:, :3], nrm, cuv))
    if not out:
        print('  no geometry in', rel)
    return d, W, out


def prop_matrix(rel, point):
    d = Z.Dae(os.path.join(ART, 'meshes', rel))
    W = d.rest_world()
    ni = d.by_name.get('prop-' + point)
    if ni is None:
        ni = d.by_name.get('prop_' + point)
    if ni is None:
        print('  no prop point', point, 'in', rel)
        return np.eye(4)
    return W[ni]


def main():
    os.makedirs(OUT, exist_ok=True)
    blob = bytearray()
    textures = {}
    kinds = []
    for name, spec in KINDS.items():
        variants = []
        scale = None
        for parts in spec['variants']:
            built = []
            for mesh, tex, attach in parts:
                base = prop_matrix(*attach) if attach else np.eye(4)
                _, _, geo = mesh_parts(mesh, base)
                if not geo:
                    continue
                p = np.concatenate([g[0] for g in geo]) @ Z.C[:3, :3].T
                n = np.concatenate([g[1] for g in geo]) @ Z.C[:3, :3].T
                uv = np.concatenate([g[2] for g in geo])
                built.append([p, n, uv, tex])
            if not built:
                continue
            allp = np.concatenate([b[0] for b in built])
            floor = allp[:, 1].min()
            h = allp[:, 1].max() - floor
            if scale is None:
                scale = spec['height'] / h
            out_parts = []
            for p, n, uv, tex in built:
                p = (p - [0, floor, 0]) * scale
                n = n / np.maximum(1e-8, np.linalg.norm(n, axis=1, keepdims=True))
                stacked = np.concatenate([p, n, uv], axis=1).astype(np.float32)
                uniq, inverse = np.unique(np.round(stacked, 4), axis=0, return_inverse=True)
                verts = uniq.astype(np.float32)
                idx = inverse.reshape(-1).astype(np.uint32)
                if tex not in textures:
                    img = Z.load_texture(tex)
                    if img is None:
                        img = Image.new('RGBA', (8, 8), (60, 90, 40, 255))
                    fname = os.path.splitext(os.path.basename(tex))[0] + '.png'
                    img.save(os.path.join(OUT, fname), optimize=True)
                    textures[tex] = fname
                while len(blob) % 4:
                    blob.append(0)
                vstart = len(blob)
                blob += verts.tobytes()
                istart = len(blob)
                blob += idx.tobytes()
                out_parts.append(dict(tex=textures[tex], vOffset=vstart, vCount=len(verts), iOffset=istart, iCount=len(idx)))
                print(f'  {name}: {os.path.basename(tex)} {len(verts)} verts {len(idx) // 3} tris')
            variants.append(dict(parts=out_parts))
        kinds.append(dict(name=name, variants=variants))
    with open(os.path.join(OUT, 'trees.bin'), 'wb') as f:
        f.write(blob)
    with open(os.path.join(OUT, 'trees.json'), 'w') as f:
        json.dump(dict(kinds=kinds), f)
    print('trees.bin', len(blob) // 1024, 'KB')


if __name__ == '__main__':
    main()
