#!/usr/bin/env python3
"""
Converts 0 A.D. unit actors into crowd-ready assets for the battle renderer.

0 A.D. art is (c) Wildfire Games, licensed CC BY-SA 3.0 (https://play0ad.com).
Assets produced from it are CC BY-SA 3.0 as well.

For every unit type this writes three files into public/units/:
  <key>.json  metadata (counts, clip table, size)
  <key>.bin   mesh (positions, normals, uvs, bone indices/weights, indices) followed by
              the baked bone animation (one 3x4 matrix per bone per frame, float16)
  <key>.png   texture atlas with the faction colour already painted in

The GPU skins each soldier from the bone texture, so thousands of soldiers can play
different animations at once. Props (helmet, shield, weapon) ride on their prop-point bones.

Usage: python3 tools/assets/zeroad_units.py <0ad art dir> [unit keys...]
"""
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

NS = '{http://www.collada.org/2005/11/COLLADASchema}'
FPS = 20
RUNTIME_COLOR = True  # keep the player-colour mask so the game can tint units per faction
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'units')

ART = sys.argv[1] if len(sys.argv) > 1 else '/home/claude/vendor/0ad/binaries/data/mods/public/art'

# Z-up (COLLADA from Blender) to Y-up (three.js): (x, y, z) -> (x, z, -y)
C = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=np.float64)
C_INV = np.linalg.inv(C)

SWORD = {
    'idle': 'biped/infantry/swordsman/idle_relax_shield_01.dae',
    'ready': 'biped/infantry/swordsman/idle_ready_shield_01.dae',
    'walk': 'biped/infantry/swordsman/walk_relax_shield.dae',
    'run': 'biped/infantry/swordsman/run_relax_shield.dae',
    'attack1': 'biped/infantry/swordsman/attack_melee_shield_01.dae',
    'attack2': 'biped/infantry/swordsman/attack_melee_shield_02.dae',
    'death1': 'biped/infantry/death_a.dae',
    'death2': 'biped/infantry/death_b.dae',
}
SWORD_CELT = dict(SWORD, idle='biped/infantry/swordsman/idle_relax_shield_celt_01.dae')
SPEAR = {
    'idle': 'biped/infantry/spearman/idle_relax_shield_01.dae',
    'ready': 'biped/infantry/spearman/idle_ready_shield.dae',
    'walk': 'biped/infantry/spearman/walk_relax_shield.dae',
    'run': 'biped/infantry/spearman/run_relax_shield.dae',
    'attack1': 'biped/infantry/spearman/attack_melee_01.dae',
    'attack2': 'biped/infantry/swordsman/attack_melee_shield_03.dae',
    'death1': 'biped/infantry/death_a.dae',
    'death2': 'biped/infantry/death_b.dae',
}
JAVELIN = {
    'idle': 'biped/infantry/javelinist/idle_relax.dae',
    'ready': 'biped/infantry/javelinist/idle_ready.dae',
    'walk': 'biped/infantry/javelinist/walk_relax.dae',
    'run': 'biped/infantry/javelinist/run_relax.dae',
    'attack1': 'biped/infantry/swordsman/attack_melee_shield_01.dae',
    'attack2': 'biped/infantry/swordsman/attack_melee_shield_02.dae',
    'shoot': 'biped/infantry/javelinist/attack_ranged.dae',
    'death1': 'biped/infantry/death_a.dae',
    'death2': 'biped/infantry/death_b.dae',
}
SLING = dict(JAVELIN,
             idle='biped/infantry/slinger/idle_relax_01.dae',
             ready='biped/infantry/slinger/idle_ready.dae',
             walk='biped/infantry/slinger/walk_ready.dae',
             run='biped/infantry/slinger/jog_relax.dae',
             shoot='biped/infantry/slinger/attack_ranged.dae')

LOOPING = {'idle', 'ready', 'walk', 'run'}

ROME_COLOR = (165, 32, 26)
GAUL_COLOR = (44, 92, 160)

CAV_SPEAR = {
    'idle': ('quadraped/horse_idle_01.dae', 'biped/rider/cavalry/generic/idle_shield_relax_01.dae'),
    'ready': ('quadraped/horse_idle_01.dae', 'biped/rider/cavalry/generic/idle_shield_ready_01.dae'),
    'walk': ('quadraped/horse_trot.dae', 'biped/rider/cavalry/generic/trot_shield_relax.dae'),
    'run': ('quadraped/horse_gallop.dae', 'biped/rider/cavalry/spearman/gallop_shield_ready.dae'),
    'attack1': ('quadraped/horse_idle_01.dae', 'biped/rider/cavalry/spearman/attack_melee_shield_01.dae'),
    'attack2': ('quadraped/horse_idle_01.dae', 'biped/rider/cavalry/spearman/attack_melee_shield_02.dae'),
    'death1': ('quadraped/horse_death_01.dae', 'biped/rider/cavalry/generic/death_shield_01.dae'),
    'death2': ('quadraped/horse_death_02.dae', 'biped/rider/cavalry/generic/death_shield_02.dae'),
}
CAV_SWORD = dict(CAV_SPEAR,
                 run=('quadraped/horse_gallop.dae', 'biped/rider/cavalry/generic/gallop_shield_ready.dae'),
                 attack1=('quadraped/horse_idle_01.dae', 'biped/rider/cavalry/generic/attack_melee_shield_01.dae'),
                 attack2=('quadraped/horse_idle_01.dae', 'biped/rider/cavalry/generic/attack_melee_shield_02.dae'))

UNITS = {
    'rome_equites': dict(actor='units/romans/cavalry_spearman_b_m.xml', anims=CAV_SPEAR, color=ROME_COLOR, seed=2, height=2.75),
    'rome_general': dict(actor='units/romans/hero_cavalry_swordsman_scipio_m.xml', anims=CAV_SWORD, color=ROME_COLOR, seed=1, height=2.85),
    'gaul_cavalry': dict(actor='units/gauls/cavalry_swordsman_b_m.xml', anims=CAV_SWORD, color=GAUL_COLOR, seed=1, height=2.75),
    'gaul_chieftain': dict(actor='units/gauls/hero_cavalry_swordsman_brennus_m.xml', anims=CAV_SWORD, color=GAUL_COLOR, seed=1, height=2.85),
    'rome_hastati': dict(actor='units/romans/infantry_swordsman_b.xml', anims=SWORD, color=ROME_COLOR, seed=1),
    'rome_principes': dict(actor='units/romans/infantry_swordsman_e.xml', anims=SWORD, color=ROME_COLOR, seed=2),
    'rome_triarii': dict(actor='units/romans/infantry_spearman_b.xml', anims=SPEAR, color=ROME_COLOR, seed=1),
    'rome_velites': dict(actor='units/romans/infantry_javelinist_b.xml', anims=JAVELIN, color=ROME_COLOR, seed=1),
    'gaul_warband': dict(actor='units/gauls/infantry_swordsman_b.xml', anims=SWORD_CELT, color=GAUL_COLOR, seed=1),
    'gaul_spear': dict(actor='units/gauls/infantry_spearman_b.xml', anims=SPEAR, color=GAUL_COLOR, seed=2),
    'gaul_slinger': dict(actor='units/gauls/infantry_slinger_b.xml', anims=SLING, color=GAUL_COLOR, seed=1),
}


# ----------------------------------------------------------------------------- actors
class Actor:
    def __init__(self):
        self.mesh = None
        self.tex = None
        self.props = []  # (attachpoint, actor path)
        self.material = ''


def load_actor(path, seed=0):
    root = ET.parse(os.path.join(ART, 'actors', path)).getroot()
    a = Actor()
    for gi, group in enumerate(root.findall('group')):
        variants = group.findall('variant')
        if not variants:
            continue
        # Animation-only variant groups (biped/..., quadraped/base_...) carry no looks.
        if all((v.get('file') or '').startswith(('biped/', 'quadraped/base')) for v in variants):
            continue
        v = pick_variant(variants, seed + gi)
        apply_variant(v, a)
    m = root.find('material')
    a.material = (m.text or '') if m is not None else ''
    return a


def pick_variant(variants, salt):
    for v in variants:
        if (v.get('name') or '').lower() in ('alive', 'base'):
            return v
    usable = [v for v in variants if not (v.get('file') or '').startswith(('biped/', 'quadraped/base'))]
    usable = usable or variants
    return usable[salt % len(usable)] if len(usable) > 1 else usable[0]


def apply_variant(v, a):
    f = v.get('file')
    if f:
        p = os.path.join(ART, 'variants', f)
        if os.path.exists(p):
            apply_variant(ET.parse(p).getroot(), a)
    m = v.find('mesh')
    if m is not None and m.text:
        a.mesh = m.text.strip()
    for t in v.findall('textures/texture'):
        if t.get('name') == 'baseTex':
            a.tex = t.get('file')
    new = [(p.get('attachpoint'), p.get('actor')) for p in v.findall('props/prop')]
    if new:
        points = {ap for ap, _ in new}
        a.props = [(ap, act) for ap, act in a.props if ap not in points]
        a.props += [(ap, act) for ap, act in new if act]


# ----------------------------------------------------------------------------- COLLADA
def floats(el):
    return np.array((el.text or '').split(), dtype=np.float64)


def node_local(n):
    M = np.eye(4)
    for c in n:
        tag = c.tag.replace(NS, '')
        if tag == 'matrix':
            M = M @ floats(c).reshape(4, 4)
        elif tag == 'translate':
            t = floats(c)
            T = np.eye(4)
            T[:3, 3] = t
            M = M @ T
        elif tag == 'rotate':
            x, y, z, ang = floats(c)
            M = M @ axis_angle(np.array([x, y, z]), math.radians(ang))
        elif tag == 'scale':
            s = floats(c)
            M = M @ np.diag([s[0], s[1], s[2], 1])
    return M


def axis_angle(axis, a):
    axis = axis / (np.linalg.norm(axis) or 1)
    x, y, z = axis
    c, s, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    R = np.eye(4)
    R[:3, :3] = [[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                 [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                 [t * x * z - s * y, t * y * z + s * x, t * z * z + c]]
    return R


class Dae:
    def __init__(self, path):
        self.path = path
        self.root = ET.parse(path).getroot()
        self.geoms = {g.get('id'): g for g in self.root.iter(NS + 'geometry')}
        self.ctrls = {c.get('id'): c for c in self.root.iter(NS + 'controller')}
        self.nodes = []  # dicts: id, name, sid, parent, local, el
        scene = self.root.find(f'{NS}library_visual_scenes/{NS}visual_scene')
        if scene is not None:
            for n in scene.findall(NS + 'node'):
                self._walk(n, -1)
        self.by_id = {n['id']: i for i, n in enumerate(self.nodes) if n['id']}
        self.by_name = {}
        for i, n in enumerate(self.nodes):
            for k in (n['name'], n['sid']):
                if k and k not in self.by_name:
                    self.by_name[k] = i

    def _walk(self, el, parent):
        idx = len(self.nodes)
        self.nodes.append(dict(id=el.get('id'), name=el.get('name'), sid=el.get('sid'), parent=parent,
                               local=node_local(el), el=el, type=el.get('type')))
        for c in el.findall(NS + 'node'):
            self._walk(c, idx)

    def world(self, locals_):
        W = [None] * len(self.nodes)
        for i, n in enumerate(self.nodes):
            L = locals_[i]
            W[i] = L if n['parent'] < 0 else W[n['parent']] @ L
        return W

    def rest_world(self):
        return self.world([n['local'] for n in self.nodes])


def read_source(src):
    fa = src.find(NS + 'float_array')
    na = src.find(NS + 'Name_array')
    acc = src.find(f'{NS}technique_common/{NS}accessor')
    stride = int(acc.get('stride', 1)) if acc is not None else 1
    if fa is not None:
        return floats(fa).reshape(-1, stride)
    if na is not None:
        return (na.text or '').split()
    return None


def read_geometry(geom):
    """Returns per-corner arrays: pos index, normal (xyz), uv, and triangle count."""
    mesh = geom.find(NS + 'mesh')
    sources = {s.get('id'): read_source(s) for s in mesh.findall(NS + 'source')}
    vert_el = mesh.find(NS + 'vertices')
    vert_src = {}
    for inp in vert_el.findall(NS + 'input'):
        vert_src[inp.get('semantic')] = inp.get('source')[1:]
    positions = sources[vert_src['POSITION']]
    corners_pos, corners_n, corners_uv = [], [], []
    for prim in list(mesh.findall(NS + 'triangles')) + list(mesh.findall(NS + 'polylist')) + list(mesh.findall(NS + 'polygons')):
        inputs = prim.findall(NS + 'input')
        stride = max(int(i.get('offset')) for i in inputs) + 1
        p_el = prim.find(NS + 'p')
        if p_el is None:
            continue
        p = np.array(p_el.text.split(), dtype=np.int64).reshape(-1, stride)
        tag = prim.tag.replace(NS, '')
        if tag == 'polylist':
            vcount = np.array(prim.find(NS + 'vcount').text.split(), dtype=np.int64)
            tri_rows = []
            base = 0
            for vc in vcount:
                for k in range(1, vc - 1):
                    tri_rows += [base, base + k, base + k + 1]
                base += vc
            p = p[tri_rows]
        off_v = off_n = off_t = None
        src_n = src_t = None
        for i in inputs:
            sem = i.get('semantic')
            if sem == 'VERTEX':
                off_v = int(i.get('offset'))
                if 'NORMAL' in vert_src:
                    off_n, src_n = off_v, vert_src['NORMAL']
            elif sem == 'NORMAL':
                off_n, src_n = int(i.get('offset')), i.get('source')[1:]
            elif sem == 'TEXCOORD' and (src_t is None or i.get('set') in (None, '0')):
                off_t, src_t = int(i.get('offset')), i.get('source')[1:]
        pi = p[:, off_v]
        corners_pos.append(pi)
        corners_n.append(sources[src_n][p[:, off_n]][:, :3] if src_n else np.zeros((len(pi), 3)))
        corners_uv.append(sources[src_t][p[:, off_t]][:, :2] if src_t else np.zeros((len(pi), 2)))
    return positions[:, :3], np.concatenate(corners_pos), np.concatenate(corners_n), np.concatenate(corners_uv)


def read_skin(ctrl):
    skin = ctrl.find(NS + 'skin')
    bsm = floats(skin.find(NS + 'bind_shape_matrix')).reshape(4, 4)
    sources = {s.get('id'): read_source(s) for s in skin.findall(NS + 'source')}
    joints_el = skin.find(NS + 'joints')
    jn = ibm = None
    for inp in joints_el.findall(NS + 'input'):
        if inp.get('semantic') == 'JOINT':
            jn = sources[inp.get('source')[1:]]
        elif inp.get('semantic') == 'INV_BIND_MATRIX':
            ibm = sources[inp.get('source')[1:]].reshape(-1, 4, 4)
    vw = skin.find(NS + 'vertex_weights')
    vcount = np.array(vw.find(NS + 'vcount').text.split(), dtype=np.int64)
    v = np.array(vw.find(NS + 'v').text.split(), dtype=np.int64)
    off_j = off_w = 0
    wsrc = None
    nin = 0
    for inp in vw.findall(NS + 'input'):
        nin = max(nin, int(inp.get('offset')) + 1)
        if inp.get('semantic') == 'JOINT':
            off_j = int(inp.get('offset'))
        elif inp.get('semantic') == 'WEIGHT':
            off_w = int(inp.get('offset'))
            wsrc = sources[inp.get('source')[1:]].reshape(-1)
    v = v.reshape(-1, nin)
    weights = []
    k = 0
    for c in vcount:
        pairs = [(int(v[k + i, off_j]), float(wsrc[v[k + i, off_w]])) for i in range(c)]
        pairs.sort(key=lambda t: -t[1])
        pairs = pairs[:4]
        s = sum(w for _, w in pairs) or 1
        weights.append([(j, w / s) for j, w in pairs])
        k += c
    return skin.get('source')[1:], bsm, jn, ibm, weights


class Animation:
    def __init__(self, path):
        root = ET.parse(path).getroot()
        self.channels = {}  # node id -> (times, mats)
        self.duration = 0.0
        for anim in root.iter(NS + 'animation'):
            sources = {s.get('id'): s for s in anim.findall(NS + 'source')}
            samplers = {s.get('id'): s for s in anim.findall(NS + 'sampler')}
            for ch in anim.findall(NS + 'channel'):
                target = ch.get('target') or ''
                if not target.endswith('/transform'):
                    continue
                node_id = target.split('/')[0]
                smp = samplers.get(ch.get('source')[1:])
                if smp is None:
                    continue
                ins = {i.get('semantic'): i.get('source')[1:] for i in smp.findall(NS + 'input')}
                times = floats(sources[ins['INPUT']].find(NS + 'float_array'))
                mats = floats(sources[ins['OUTPUT']].find(NS + 'float_array')).reshape(-1, 4, 4)
                self.channels[node_id] = (times, mats)
                if len(times):
                    self.duration = max(self.duration, float(times[-1]))

    def sample(self, node_id, t):
        ch = self.channels.get(node_id)
        if ch is None:
            return None
        times, mats = ch
        if t <= times[0]:
            return mats[0]
        if t >= times[-1]:
            return mats[-1]
        i = int(np.searchsorted(times, t)) - 1
        f = (t - times[i]) / max(1e-6, times[i + 1] - times[i])
        return mats[i] * (1 - f) + mats[i + 1] * f


# ----------------------------------------------------------------------------- textures
def load_texture(rel):
    if not rel:
        return None
    for base in ('textures/skins',):
        p = os.path.join(ART, base, rel)
        if os.path.exists(p):
            try:
                return Image.open(p).convert('RGBA')
            except Exception as e:  # noqa: BLE001
                print('  texture failed', rel, e)
                return None
        # Some actors reference .dds names whose source is .png, or the other way round.
        stem = os.path.splitext(p)[0]
        for ext in ('.png', '.dds', '.tga'):
            if os.path.exists(stem + ext):
                try:
                    return Image.open(stem + ext).convert('RGBA')
                except Exception as e:  # noqa: BLE001
                    print('  texture failed', rel, e)
                    return None
    print('  missing texture', rel)
    return None


def paint_player(img, material, color):
    """0 A.D. 'player' materials store the player-colour mask in alpha. Bake the colour in."""
    if img is None:
        return None
    a = np.asarray(img).astype(np.float32)
    player = 'player' in (material or '')
    if player and color is not None:
        alpha = a[:, :, 3:4] / 255.0
        col = np.array(color, dtype=np.float32).reshape(1, 1, 3)
        a[:, :, :3] = a[:, :, :3] * alpha + col * (1 - alpha) * (0.55 + 0.45 * a[:, :, :3].mean(axis=2, keepdims=True) / 255.0)
        a[:, :, 3] = 255
        player = False
    elif not player and 'trans' not in (material or ''):
        a[:, :, 3] = 255
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
    # With no colour given, the mask stays in alpha and the game tints it with the team colour.
    out.info['player'] = player
    return out


# ----------------------------------------------------------------------------- assembling a unit
class Part:
    def __init__(self, name):
        self.name = name
        self.pos = None  # (n,3) in part bind space (Z-up)
        self.nrm = None
        self.uv = None
        self.bones = None  # (n,4) indices into the global bone list
        self.weights = None  # (n,4)
        self.image = None


class Rig:
    """One skeleton (a body or a horse) with its parts. Bones are appended to a shared list."""

    def __init__(self, actor, color, seed, bones, parts):
        self.actor = actor
        self.body = Dae(os.path.join(ART, 'meshes', actor.mesh))
        self.color = color
        self.seed = seed
        self.bones = bones  # shared list of (rig, kind, ref, extra)
        self.parts = parts
        self.children = []  # (attach node idx, Rig)
        self.root = None  # parent attach: (parent rig, node idx) or None
        self.anim = None  # Animation currently applied
        self._add_body()
        self._add_props(actor, ('node', None), 0)

    def _skin_part(self, dae, ctrl_id, image, name):
        geom_id, bsm, jnames, ibms, weights = read_skin(dae.ctrls[ctrl_id])
        positions, cp, cn, cuv = read_geometry(dae.geoms[geom_id])
        joint_bone = []
        for ji, jn in enumerate(jnames):
            ni = self.body.by_name.get(jn)
            if ni is None:
                ni = self.body.by_id.get('Biped_' + jn)
            # Share a bone with an earlier part when it is the same joint with the same bind.
            found = -1
            for bi, (rig, kind, ref, extra) in enumerate(self.bones):
                if rig is self and kind == 'skin' and ref == ni and np.allclose(extra, ibms[ji], atol=1e-4):
                    found = bi
                    break
            if found < 0:
                found = len(self.bones)
                self.bones.append((self, 'skin', ni, ibms[ji]))
            joint_bone.append(found)
        part = Part(name)
        v4 = np.c_[positions[cp], np.ones(len(cp))] @ bsm.T
        part.pos = v4[:, :3]
        part.nrm = cn @ bsm[:3, :3].T
        part.uv = cuv
        bw = np.zeros((len(cp), 4), dtype=np.int64)
        ww = np.zeros((len(cp), 4))
        for c, pi in enumerate(cp):
            for k, (j, w) in enumerate(weights[pi]):
                bw[c, k] = joint_bone[j]
                ww[c, k] = w
        part.bones, part.weights = bw, ww
        part.image = image
        self.parts.append(part)

    def _add_body(self):
        ctrl_id = next(iter(self.body.ctrls))
        img = paint_player(load_texture(self.actor.tex), self.actor.material, None if RUNTIME_COLOR else self.color)
        self._skin_part(self.body, ctrl_id, img, 'body')

    def _add_props(self, actor, attach, depth):
        for ap, act in actor.props:
            if act.startswith('units/'):
                # A rider (or other full unit) sits on this prop point.
                ni = self.body.by_name.get('prop-' + ap)
                if ni is None:
                    ni = self.body.by_name.get('prop_' + ap)
                if ni is None or ap != 'rider':
                    continue
                rider = Rig(load_actor(act, self.seed), self.color, self.seed, self.bones, self.parts)
                rider.root = (self, ni)
                self.children.append(rider)
                continue
            if ap == 'root':
                self._add_prop(act, ('node', None), depth + 1)
                continue
            ni = self.body.by_name.get('prop-' + ap)
            if ni is None:
                ni = self.body.by_name.get('prop_' + ap)
            if ni is None:
                print('  no prop point', ap)
                continue
            self._add_prop(act, ('node', ni), depth + 1)

    def _add_prop(self, path, attach, depth):
        if depth > 4:
            return
        pa = load_actor(path, self.seed)
        if not pa.mesh:
            for ap, act in pa.props:
                self._add_prop(act, attach, depth + 1)
            return
        mpath = os.path.join(ART, 'meshes', pa.mesh)
        if not os.path.exists(mpath):
            print('  missing prop mesh', pa.mesh)
            return
        d = Dae(mpath)
        rest = d.rest_world()
        img = paint_player(load_texture(pa.tex), pa.material, None if RUNTIME_COLOR else self.color)
        for ni, n in enumerate(d.nodes):
            inst = n['el'].find(NS + 'instance_geometry')
            inst_c = n['el'].find(NS + 'instance_controller')
            if inst_c is not None and inst_c.get('url')[1:] in d.ctrls:
                # Skinned prop (cloak, reins): deform with this rig's skeleton.
                self._skin_part(d, inst_c.get('url')[1:], img, pa.mesh)
                continue
            if inst is None:
                continue
            gid = inst.get('url')[1:]
            if gid not in d.geoms:
                continue
            pos, cp2, cn2, cuv2 = read_geometry(d.geoms[gid])
            b = len(self.bones)
            self.bones.append((self, 'prop', attach, rest[ni]))
            pp = Part(pa.mesh)
            pp.pos = pos[cp2]
            pp.nrm = cn2
            pp.uv = cuv2
            pp.bones = np.zeros((len(cp2), 4), dtype=np.int64)
            pp.bones[:, 0] = b
            pp.weights = np.zeros((len(cp2), 4))
            pp.weights[:, 0] = 1
            pp.image = img
            self.parts.append(pp)
        for ap, act in pa.props:
            pn = d.by_name.get('prop-' + ap)
            if pn is None:
                pn = d.by_name.get('prop_' + ap)
            if ap == 'root' or pn is None:
                self._add_prop(act, attach, depth + 1)
            else:
                self._add_prop(act, ('nested', attach, rest[pn]), depth + 1)

    def worlds(self, anims, t, loop, parent_worlds=None):
        """Node world matrices for this rig at time t, keyed by rig."""
        out = {}
        anim = anims.get(id(self))
        locals_ = []
        for n in self.body.nodes:
            m = None
            if anim is not None and n['id']:
                tt = (t % anim.duration) if (loop and anim.duration > 0) else min(t, anim.duration)
                m = anim.sample(n['id'], tt)
            locals_.append(m if m is not None else n['local'])
        W = self.body.world(locals_)
        if self.root is not None:
            parent_rig, ni = self.root
            R = parent_worlds[id(parent_rig)][ni]
            W = [R @ w for w in W]
        out[id(self)] = W
        for child in self.children:
            out.update(child.worlds(anims, t, loop, out))
        return out


def attach_matrix(attach, W):
    kind = attach[0]
    if kind == 'node':
        return np.eye(4) if attach[1] is None else W[attach[1]]
    if kind == 'nested':
        return attach_matrix(attach[1], W) @ attach[2]
    raise ValueError(kind)


def build_unit(key, spec):
    print('==', key)
    bones = []
    parts = []
    main = Rig(load_actor(spec['actor'], spec.get('seed', 0)), spec['color'], spec.get('seed', 0), bones, parts)
    rigs = [main] + main.children
    rider = main.children[0] if main.children else None

    def bone_mats(Ws):
        out = []
        for rig, kind, ref, extra in bones:
            W = Ws[id(rig)]
            if kind == 'skin':
                out.append(W[ref] @ extra if ref is not None else np.eye(4))
            else:
                out.append(attach_matrix(ref, W) @ extra)
        return out

    clips = {}
    frames = []
    for name, rel in spec['anims'].items():
        # A clip is either one file (infantry) or (horse file, rider file) for cavalry.
        files = rel if isinstance(rel, tuple) else (rel,)
        anims = {}
        duration = 0.0
        ok = True
        for rig, f in zip(rigs if len(files) > 1 else [main], files):
            path = os.path.join(ART, 'animation', f)
            if not os.path.exists(path):
                print('  missing animation', f)
                ok = False
                break
            a = Animation(path)
            anims[id(rig)] = a
            duration = max(duration, a.duration) if rig is main else duration or a.duration
        if not ok:
            continue
        loop = name in LOOPING
        n_frames = max(2, int(round(duration * FPS)) + 1)
        start = len(frames)
        for f in range(n_frames):
            t = min(duration, f / FPS)
            frames.append(bone_mats(main.worlds(anims, t, loop)))
        clips[name] = dict(start=start, count=n_frames, loop=loop)
        print(f'  {name}: {n_frames} frames ({duration:.2f}s)')

    all_pos = np.concatenate([p.pos for p in parts])
    all_nrm = np.concatenate([p.nrm for p in parts])
    all_bones = np.concatenate([p.bones for p in parts])
    all_w = np.concatenate([p.weights for p in parts])
    all_flags = np.concatenate([np.full(len(p.pos), 1 if (p.image is not None and p.image.info.get('player')) else 0) for p in parts])

    idle0 = frames[clips['idle']['start']] if 'idle' in clips else frames[0]
    skinned = skin_positions(all_pos, all_bones, all_w, idle0)
    yup = skinned @ C[:3, :3].T
    h = yup[:, 1].max() - yup[:, 1].min()
    target = spec.get('height', 1.8)
    scale = target / h if h > 0 else 1.0
    floor = yup[:, 1].min() * scale
    K = np.diag([scale, scale, scale, 1.0])
    K[1, 3] = -floor
    # Keep only bones that actually move some vertex, and renumber them.
    used = sorted(set(all_bones[all_w > 0].tolist()))
    remap = np.zeros(len(bones), dtype=np.int64)
    for k, b in enumerate(used):
        remap[b] = k
    all_bones = remap[all_bones]
    anim = np.zeros((len(frames), len(used), 12), dtype=np.float32)
    for fi, mats in enumerate(frames):
        for k, bi in enumerate(used):
            B = K @ C @ mats[bi]
            anim[fi, k] = B[:3, :4].reshape(-1)
    if len(used) > 255:
        raise RuntimeError(f'too many bones: {len(used)}')
    bones = used
    atlas, uvs = build_atlas(parts)
    nrm = all_nrm / np.maximum(1e-8, np.linalg.norm(all_nrm, axis=1, keepdims=True))
    write_unit(key, all_pos.astype(np.float32), nrm.astype(np.float32), uvs.astype(np.float32),
               all_bones.astype(np.uint8), (all_w * 255).round().astype(np.uint8), anim, clips, atlas, len(bones), all_flags)


def skin_positions(pos, bones, weights, mats):
    out = np.zeros((len(pos), 3))
    p4 = np.c_[pos, np.ones(len(pos))]
    for k in range(4):
        w = weights[:, k]
        if not w.any():
            continue
        M = np.stack([mats[b] for b in bones[:, k]])  # (n,4,4)
        out += w[:, None] * np.einsum('nij,nj->ni', M, p4)[:, :3]
    return out


def build_atlas(parts, size=1024):
    """Shelf-pack every distinct part image into one atlas; remap UVs."""
    for max_cell in (512, 384, 256, 192):
        try:
            return _build_atlas(parts, size, max_cell)
        except RuntimeError:
            continue
    raise RuntimeError('atlas overflow even at small cells')


def _build_atlas(parts, size, max_cell):
    images = []
    index = {}
    for p in parts:
        key = id(p.image) if p.image is not None else None
        if key not in index:
            index[key] = len(images)
            images.append(p.image)
    # Fit each image into a cell; big textures get downscaled.
    cells = []
    for img in images:
        if img is None:
            img = Image.new('RGBA', (8, 8), (128, 128, 128, 255))
        w, h = img.size
        s = min(1.0, max_cell / max(w, h))
        cells.append(img.resize((max(4, int(w * s)), max(4, int(h * s))), Image.LANCZOS) if s < 1 else img)
    order = sorted(range(len(cells)), key=lambda i: -cells[i].size[1])
    atlas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    x = y = shelf = 0
    rects = [None] * len(cells)
    pad = 2
    for i in order:
        w, h = cells[i].size
        if x + w > size:
            x, y, shelf = 0, y + shelf + pad, 0
        if y + h > size:
            raise RuntimeError('atlas overflow')
        atlas.paste(cells[i], (x, y))
        rects[i] = (x, y, w, h)
        x += w + pad
        shelf = max(shelf, h)
    used_h = y + shelf
    final = 1
    while final < used_h:
        final *= 2
    atlas = atlas.crop((0, 0, size, max(final, 64)))
    W, H = atlas.size
    uvs = []
    for p in parts:
        x0, y0, w, h = rects[index[id(p.image) if p.image is not None else None]]
        u = np.mod(p.uv[:, 0], 1.0)
        v = np.mod(p.uv[:, 1], 1.0)
        # UV origin is bottom-left; atlas rows count from the top.
        uu = (x0 + u * (w - 1) + 0.5) / W
        vv = 1 - (y0 + (1 - v) * (h - 1) + 0.5) / H
        uvs.append(np.c_[uu, vv])
    # Downscale the atlas for crowd use.
    atlas = atlas.resize((W // 2, H // 2), Image.LANCZOS)
    return atlas, np.concatenate(uvs)


def write_unit(key, pos, nrm, uv, bones, weights, anim, clips, atlas, n_bones, flags):
    os.makedirs(OUT, exist_ok=True)
    # Corners were expanded per triangle: deduplicate identical corners.
    stacked = np.concatenate([pos, nrm, uv, bones.astype(np.float32), weights.astype(np.float32), flags[:, None].astype(np.float32)], axis=1)
    uniq, inverse = np.unique(np.round(stacked, 5), axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    pos, nrm, uv = uniq[:, 0:3], uniq[:, 3:6], uniq[:, 6:8]
    bones, weights = uniq[:, 8:12].astype(np.uint8), uniq[:, 12:16].astype(np.uint8)
    flag4 = np.zeros((len(uniq), 4), dtype=np.uint8)
    flag4[:, 0] = uniq[:, 16].astype(np.uint8)
    idx = inverse.astype(np.uint16 if len(uniq) < 65536 else np.uint32)
    meta = dict(vertices=int(len(uniq)), indices=int(len(idx)), indexType='u16' if idx.dtype == np.uint16 else 'u32',
                bones=int(n_bones), frames=int(anim.shape[0]), fps=FPS, clips=clips, version=2,
                license='CC BY-SA 3.0, based on 0 A.D. art by Wildfire Games')
    with open(os.path.join(OUT, key + '.bin'), 'wb') as f:
        f.write(pos.astype(np.float32).tobytes())
        f.write(nrm.astype(np.float32).tobytes())
        f.write(uv.astype(np.float32).tobytes())
        f.write(bones.tobytes())
        f.write(weights.tobytes())
        f.write(flag4.tobytes())
        f.write(idx.tobytes())
        if idx.nbytes % 4:
            f.write(b'\0' * (4 - idx.nbytes % 4))
        f.write(anim.astype(np.float16).tobytes())
    with open(os.path.join(OUT, key + '.json'), 'w') as f:
        json.dump(meta, f)
    atlas.save(os.path.join(OUT, key + '.png'), optimize=True)
    print(f'  -> {len(uniq)} verts, {len(idx) // 3} tris, {n_bones} bones, {anim.shape[0]} frames, atlas {atlas.size}')


if __name__ == '__main__':
    keys = sys.argv[2:] or list(UNITS)
    for k in keys:
        build_unit(k, UNITS[k])
