"""
Генератор моделей монстров для «ОНИ ЗДЕСЬ» (Blender 4.2+ / 5.x).

Запуск:
    blender -b -P blender/build_monsters.py -- [--no-render]
или с модулем bpy из PyPI (Python 3.11):
    python blender/build_monsters.py [--no-render]

Результат:
    models/<monster>.glb   — модели для сайта (glTF binary)
    img/<monster>.jpg      — превью для меню (рендер Cycles)

Правила стиля (из ТЗ):
  1) Никаких круглых кривых и сфер. Все «округлости» собраны из угловых
     пластин: сечения — многоугольники с 3–12 гранями, плоское затенение.
  2) Никаких резких углов и тупых срезов: каждая деталь заканчивается
     скошенной фаской или «вырезанной» пирамидальной шапкой, коробки — со
     срезанными рёбрами. Блочность сохраняется.

Иерархия объектов (её анимирует сайт по именам узлов):
  <root> → Hips → Spine → Neck → Head → Jaw
                       → UpperArm.L/R → Forearm.L/R → Hand.L/R
         → Hips → Thigh.L/R → Shin.L/R
         → Hips → Robe (если есть)
"""
import math
import os
import random
import sys

import bpy  # bpy первым: в сборке bpy из PyPI он регистрирует bmesh/mathutils
import bmesh
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_MODELS = os.path.join(ROOT, "models")
OUT_IMG = os.path.join(ROOT, "img")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
DO_RENDER = "--no-render" not in argv
ONLY = [a for a in argv if not a.startswith("--")]

pi = math.pi


# ----------------------------------------------------------------- профили --
def ngon(n):
    """Правильный n-угольник; грань (а не ребро) смотрит вперёд (-Y)."""
    ph = -pi / 2 + pi / n
    return [(math.cos(ph + 2 * pi * i / n), math.sin(ph + 2 * pi * i / n)) for i in range(n)]


# квадрат со срезанными углами — основа «блочных» деталей без острых рёбер
CHSQ = [(-0.62, -1), (0.62, -1), (1, -0.62), (1, 0.62), (0.62, 1), (-0.62, 1), (-1, 0.62), (-1, -0.62)]
# клин: ребро смотрит вперёд (нос, хрящи)
WEDGE = [(0, -1), (0.75, -0.25), (0.85, 0.55), (-0.85, 0.55), (-0.75, -0.25)]


def R(z, rx, ry=None, ox=0.0, oy=0.0, jr=None, jz=None):
    """Кольцо лофта: высота z, радиусы rx/ry, смещение ox/oy, джиттер радиуса/высоты по вершинам."""
    return dict(z=z, rx=rx, ry=rx if ry is None else ry, ox=ox, oy=oy, jr=jr, jz=jz)


def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def Rx(a):
    return Matrix.Rotation(a, 4, "X")


def Ry(a):
    return Matrix.Rotation(a, 4, "Y")


def Rz(a):
    return Matrix.Rotation(a, 4, "Z")


def T(x, y, z):
    return Matrix.Translation((x, y, z))


FWD = Rx(pi / 2)  # ось лофта Z → вперёд (-Y)
DOWN = Rx(pi)     # ось лофта Z → вниз


# ----------------------------------------------------------------- материалы --
def material(name, hexcol, rough=0.85, metal=0.0, emit=0.0, emit_hex=None):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*srgb(hexcol), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit > 0:
        b.inputs["Emission Color"].default_value = (*srgb(emit_hex or hexcol), 1)
        b.inputs["Emission Strength"].default_value = emit
    return m


# ----------------------------------------------------------------- геометрия --
class Part:
    """Собирает один объект из множества лофтов (угловых пластин)."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def loft(self, rings, mat, prof=None, M=Matrix(), cap0=0.35, cap1=0.35):
        """Лофт по оси Z через кольца-сечения. Концы закрываются скошенной
        «вырезанной» шапкой (кольцо-фаска + низкая пирамида), а не плоским срезом."""
        prof = prof or ngon(8)
        bm = self.bm
        n = len(prof)
        made_v, made_f = [], []
        rings_v = []
        for r in rings:
            ring = []
            for i, (px, py) in enumerate(prof):
                k = 1 + (r["jr"][i % len(r["jr"])] if r["jr"] else 0)
                dz = r["jz"][i % len(r["jz"])] if r["jz"] else 0
                v = bm.verts.new((r["ox"] + px * r["rx"] * k, r["oy"] + py * r["ry"] * k, r["z"] + dz))
                ring.append(v)
            made_v += ring
            rings_v.append(ring)
        for a, b in zip(rings_v, rings_v[1:]):
            for i in range(n):
                j = (i + 1) % n
                made_f.append(bm.faces.new((a[i], a[j], b[j], b[i])))

        def cap(ring, r, other, depth_f):
            d = 1 if r["z"] >= other["z"] else -1
            rad = max(r["rx"], r["ry"])
            cx, cy, cz = r["ox"], r["oy"], r["z"]
            if depth_f is None:
                made_f.append(bm.faces.new(ring if d > 0 else list(reversed(ring))))
                return
            inset = []
            for v in ring:
                p = Vector((cx + (v.co.x - cx) * 0.55, cy + (v.co.y - cy) * 0.55, v.co.z + d * rad * depth_f * 0.55))
                inset.append(bm.verts.new(p))
            made_v.extend(inset)
            for i in range(n):
                j = (i + 1) % n
                q = (ring[i], ring[j], inset[j], inset[i])
                made_f.append(bm.faces.new(q if d > 0 else tuple(reversed(q))))
            tip = bm.verts.new((cx, cy, cz + d * rad * depth_f))
            made_v.append(tip)
            for i in range(n):
                j = (i + 1) % n
                t = (inset[i], inset[j], tip)
                made_f.append(bm.faces.new(t if d > 0 else tuple(reversed(t))))

        cap(rings_v[0], rings[0], rings[1], cap0)
        cap(rings_v[-1], rings[-1], rings[-2], cap1)
        mi = self._mi(mat)
        for f in made_f:
            f.material_index = mi
            f.smooth = False
        bmesh.ops.transform(bm, matrix=M, verts=made_v)
        return self

    def box(self, sx, sy, sz, mat, M=Matrix(), ch=0.28):
        """Коробка со срезанными рёбрами (фаски вместо острых углов)."""
        c = ch * min(sx, sy, sz)
        k = 1 - 2 * c / min(sx, sy)
        rings = [R(-sz / 2, sx / 2 * k, sy / 2 * k), R(-sz / 2 + c, sx / 2, sy / 2),
                 R(sz / 2 - c, sx / 2, sy / 2), R(sz / 2, sx / 2 * k, sy / 2 * k)]
        return self.loft(rings, mat, CHSQ, M, None, None)

    def build(self, parent=None, pivot=(0, 0, 0), parent_pivot=(0, 0, 0)):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        place(ob, parent, pivot, parent_pivot)
        return ob


def place(ob, parent, pivot, parent_pivot):
    ob.location = Vector(pivot) - Vector(parent_pivot)
    if parent is not None:
        ob.parent = parent
        ob.matrix_parent_inverse = Matrix()


def empty(name, parent=None, pivot=(0, 0, 0), parent_pivot=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.2
    bpy.context.scene.collection.objects.link(ob)
    place(ob, parent, pivot, parent_pivot)
    return ob


def taper_rings(z0, z1, r0, r1, n=4, ry_k=1.0, bulge=0.0, ox=0.0, oy=0.0):
    out = []
    for i in range(n):
        t = i / (n - 1)
        r = r0 + (r1 - r0) * t + bulge * math.sin(t * pi)
        out.append(R(z0 + (z1 - z0) * t, r, r * ry_k, ox, oy))
    return out


# ----------------------------------------------------------------- гуманоид --
class Humanoid:
    """Базовое угловатое тело. Монстры отличаются параметрами и «фичами» лица."""

    def __init__(self, key, p, m):
        self.key, self.p, self.m = key, p, m
        rnd = random.Random(p.get("seed", 1))
        self.rnd = rnd

    # ---- тело
    def build(self):
        p, m = self.p, self.m
        hip_z = p["hip_z"]
        root = empty(self.key)
        self.root = root

        # таз
        hips_piv = (0, 0, hip_z)
        hp = Part("Hips")
        hp.loft([R(-0.11, 0.11 * p["hip_w"], 0.075), R(-0.06, 0.135 * p["hip_w"], 0.09),
                 R(0.02, 0.13 * p["hip_w"], 0.088), R(0.06, 0.115 * p["hip_w"], 0.08)],
                m["pants"], ngon(8), cap0=0.25, cap1=None)
        hips = hp.build(root, hips_piv)
        self.hips_piv = hips_piv

        # торс
        tw, tl = p["torso_w"], p["torso_len"]
        sp_piv = (0, 0, hip_z + 0.05)
        sp = Part("Spine")
        sp.loft([R(0.0, 0.115 * tw, 0.078), R(tl * 0.22, 0.108 * tw, 0.074, 0, 0.004),
                 R(tl * 0.52, 0.14 * tw, 0.092, 0, -0.004), R(tl * 0.78, 0.16 * tw, 0.095, 0, 0.002),
                 R(tl * 0.92, 0.17 * tw, 0.085, 0, 0.012), R(tl, 0.085, 0.06, 0, 0.012)],
                m["shirt"], ngon(8), cap0=None, cap1=0.25)
        if p.get("ribs"):
            for i in range(4):
                z = tl * (0.40 + i * 0.09)
                for s in (-1, 1):
                    sp.box(0.06, 0.012, 0.012, m["skin_dark"],
                           T(s * 0.06 * tw, -0.088, z) @ Rz(s * 0.35) @ Ry(s * 0.25))
        if p.get("collar"):
            sp.loft([R(tl * 0.9, 0.09, 0.07, 0, 0.01), R(tl * 1.01, 0.075, 0.06, 0, 0.012)],
                    m["skin"], ngon(8), cap0=None, cap1=None)
        spine = sp.build(hips, sp_piv, hips_piv)
        self.extras_torso(sp_piv, spine)

        # шея
        nk_piv = (0, 0.012, sp_piv[2] + tl * 0.97)
        nk = Part("Neck")
        nl = p["neck_len"]
        nk.loft([R(-0.03, 0.045, 0.042), R(nl * 0.5, 0.036 * p["neck_w"], 0.036), R(nl + 0.02, 0.042, 0.04)],
                m["skin"], ngon(6), cap0=0.2, cap1=0.2)
        if p.get("tendons"):
            for s in (-1, 1):
                nk.box(0.012, 0.012, nl * 1.1, m["skin"], T(s * 0.022, -0.03, nl * 0.45) @ Ry(s * 0.25))
        neck = nk.build(spine, nk_piv, sp_piv)

        # голова
        hd_piv = (0, 0.0, nk_piv[2] + nl)
        self.head_piv = hd_piv
        self.build_head(neck, nk_piv)

        # руки
        for s, side in ((1, "L"), (-1, "R")):
            self.build_arm(spine, sp_piv, s, side)
        # ноги
        for s, side in ((1, "L"), (-1, "R")):
            self.build_leg(hips, hips_piv, s, side)
        if p.get("robe"):
            self.build_robe(hips, hips_piv)
        return root

    def extras_torso(self, piv, ob):
        pass

    def build_arm(self, spine, sp_piv, s, side):
        p, m = self.p, self.m
        sw = 0.165 * p["torso_w"]
        ua_piv = (s * sw, 0.01, sp_piv[2] + p["torso_len"] * 0.9)
        lu, lf = p["upper_arm"], p["forearm"]
        ua = Part("UpperArm." + side)
        ua.loft([R(0.035, 0.04, 0.045), R(-0.03, 0.046, 0.046), R(-lu * 0.5, 0.036, 0.038),
                 R(-lu + 0.01, 0.03, 0.032)], m["sleeve"], ngon(6), cap0=0.4, cap1=0.3)
        uao = ua.build(spine, ua_piv, sp_piv)
        fa_piv = (ua_piv[0], ua_piv[1], ua_piv[2] - lu)
        fa = Part("Forearm." + side)
        fa.loft([R(0.01, 0.031, 0.033), R(-lf * 0.35, 0.03 * p["arm_w"], 0.032), R(-lf + 0.01, 0.021, 0.024)],
                m["skin"], ngon(6), cap0=0.3, cap1=0.3)
        if p.get("cuffs"):
            fa.loft([R(0.0, 0.036, 0.038), R(-lf * 0.3, 0.038, 0.04, 0, 0, [0.0, 0.15, -0.05, 0.1, 0.0, 0.12])],
                    m["sleeve"], ngon(6), cap0=0.15, cap1=None)
        fao = fa.build(uao, fa_piv, ua_piv)
        h_piv = (fa_piv[0], fa_piv[1], fa_piv[2] - lf)
        h = Part("Hand." + side)
        hl, fl = p["hand"], p["finger"]
        # ладонь: тонкая по X, широкая по Y (ладонь смотрит к телу)
        h.loft([R(0.0, 0.014, 0.024), R(-0.02, 0.016, 0.034), R(-hl, 0.012, 0.036)],
               m["skin"], CHSQ, cap0=0.15, cap1=None)
        for i, fy in enumerate((-0.026, -0.009, 0.008, 0.024)):
            L = fl * (0.85, 1.0, 0.95, 0.78)[i] * (1 + self.rnd.uniform(-0.05, 0.05))
            curl = p["curl"]
            rings = []
            for k in range(5):
                t = k / 4
                rings.append(R(-t * L, 0.0075 * (1 - 0.35 * t), 0.0075 * (1 - 0.35 * t),
                               -s * curl * t * t * L, fy * (1 + 0.25 * t)))
            M = T(0, 0, -hl + 0.004)
            h.loft(rings, m["skin"], ngon(5), M, cap0=0.2, cap1=None)
            # коготь: скошенный клин на кончике
            tip = rings[-1]
            h.loft([R(0.0, 0.0055, 0.0055), R(-p["claw"] * 0.6, 0.004, 0.0045), R(-p["claw"], 0.0016, 0.002)],
                   m["claw"], ngon(4), T(tip["ox"], tip["oy"], -hl + 0.004 + tip["z"]) @ Ry(s * 0.35),
                   cap0=None, cap1=0.4)
        # большой палец — вперёд
        rings = [R(-0.01 - k * 0.018, 0.0085 * (1 - 0.08 * k), None, -s * 0.004 * k, -0.034 - 0.006 * k) for k in range(4)]
        h.loft(rings, m["skin"], ngon(5), cap0=0.2, cap1=None)
        tip = rings[-1]
        h.loft([R(0.0, 0.0055), R(-p["claw"] * 0.5, 0.004), R(-p["claw"] * 0.8, 0.0016)], m["claw"], ngon(4),
               T(tip["ox"], tip["oy"], tip["z"]), cap0=None, cap1=0.4)
        h.build(fao, h_piv, fa_piv)

    def build_leg(self, hips, hips_piv, s, side):
        p, m = self.p, self.m
        th_piv = (s * 0.075 * p["hip_w"], 0, hips_piv[2] - 0.05)
        lt = p["thigh"]
        ls = th_piv[2] - lt - 0.06
        th = Part("Thigh." + side)
        th.loft([R(0.04, 0.06, 0.065), R(-0.05, 0.065, 0.068), R(-lt * 0.6, 0.05, 0.055), R(-lt + 0.01, 0.042, 0.046)],
                m["pants"], ngon(7), cap0=0.3, cap1=0.3)
        tho = th.build(hips, th_piv, hips_piv)
        sh_piv = (th_piv[0], 0, th_piv[2] - lt)
        sh = Part("Shin." + side)
        sh.loft([R(0.01, 0.042, 0.046), R(-ls * 0.3, 0.04, 0.046, 0, 0.006), R(-ls + 0.01, 0.026, 0.03)],
                m["legs"], ngon(6), cap0=0.3, cap1=None)
        # стопа: угловатый клин вперёд, с фаской на носке
        sh.loft([R(0.0, 0.03, 0.022), R(0.06, 0.038, 0.02), R(0.15, 0.034, 0.016), R(0.18, 0.024, 0.011)],
                m["legs"], CHSQ, T(0, 0.04, -ls + 0.004) @ FWD @ Ry(0), cap0=0.3, cap1=0.45)
        sh.build(tho, sh_piv, th_piv)

    def build_robe(self, hips, hips_piv):
        p, m = self.p, self.m
        rnd = self.rnd
        n = 14
        L = hips_piv[2] - p.get("robe_hem", 0.12)
        rings = [R(0.08, 0.115 * p["torso_w"], 0.085)]
        for k, t in enumerate((0.12, 0.35, 0.6, 0.85, 1.0)):
            jr = [rnd.uniform(-0.12, 0.12) * t for _ in range(n)]
            jz = [rnd.uniform(-0.09, 0.08) * t * t for _ in range(n)] if t == 1.0 else None
            w = 0.15 + 0.16 * t ** 1.3
            rings.append(R(-t * L, w * p["robe_w"], w * 0.82 * p["robe_w"], 0, 0.01 * t, jr, jz))
        # подол рваный: последнее кольцо чуть внутрь — край «вырезан», а не обрублен
        last = rings[-1]
        rings.append(R(last["z"] - 0.015, last["rx"] * 0.94, last["ry"] * 0.94, 0, last["oy"], last["jr"], last["jz"]))
        rb = Part("Robe")
        rb.loft(rings, m["robe"], ngon(n), cap0=None, cap1=None)
        # внутренняя тёмная «юбка», чтобы снизу не просвечивало
        rb.loft([R(-L * 0.25, 0.14 * p["robe_w"], 0.11), R(-L * 0.9, 0.2 * p["robe_w"], 0.16)],
                m["mouth"], ngon(n), cap0=None, cap1=None)
        rb.build(hips, hips_piv, hips_piv)

    # ---- голова
    def head_rings(self):
        hs = self.p["head_s"]
        w = self.p["head_w"]
        rings = [R(-0.015, 0.060 * w, 0.068, 0, -0.004), R(0.03, 0.069 * w, 0.084), R(0.075, 0.077 * w, 0.093, 0, 0.003),
                 R(0.12, 0.080 * w, 0.097, 0, 0.006), R(0.165, 0.078 * w, 0.097, 0, 0.01), R(0.205, 0.066 * w, 0.086, 0, 0.012),
                 R(0.235, 0.043 * w, 0.058, 0, 0.012)]
        for r in rings:
            r["z"] *= hs
            r["rx"] *= hs
            r["ry"] *= hs
            r["oy"] *= hs
        return rings

    def face_y(self, x, z):
        """Приблизительная передняя поверхность лица (для размещения деталей)."""
        rings = self.head_rings()
        for a, b in zip(rings, rings[1:]):
            if a["z"] <= z <= b["z"]:
                t = (z - a["z"]) / (b["z"] - a["z"])
                rx = a["rx"] + (b["rx"] - a["rx"]) * t
                ry = a["ry"] + (b["ry"] - a["ry"]) * t
                oy = a["oy"] + (b["oy"] - a["oy"]) * t
                q = max(0.0, 1 - (x / rx) ** 2)
                return oy - ry * math.sqrt(q) * 0.985
        return -0.07

    def build_head(self, neck, nk_piv):
        p, m = self.p, self.m
        hs = p["head_s"]
        hd = Part("Head")
        hd.loft(self.head_rings(), m["skin"], ngon(10), cap0=None, cap1=0.3)
        # тёмная полость рта (видна, когда челюсть открыта)
        hd.box(0.085 * hs * p["head_w"], 0.09 * hs, 0.07 * hs, m["mouth"], T(0, -0.02 * hs, -0.02 * hs))
        # уши — угловые пластины
        for s in (-1, 1):
            hd.loft([R(-0.02, 0.006, 0.016), R(0.0, 0.008, 0.022), R(0.03, 0.007, 0.02), R(0.045, 0.005, 0.012)],
                    m["skin"], CHSQ, T(s * 0.079 * hs * p["head_w"], 0.012 * hs, 0.07 * hs) @ Rz(s * 0.25) @ Ry(s * 0.2),
                    cap0=0.3, cap1=0.4)
        self.face(hd)
        head = hd.build(neck, self.head_piv, nk_piv)
        # челюсть
        jaw_piv = (0, self.head_piv[1] + 0.03 * hs, self.head_piv[2] + 0.005 * hs)
        jw = Part("Jaw")
        jl = p["jaw_len"]
        jwid = p["head_w"] * p.get("jaw_w", 1.0)
        rel = T(0, -0.03 * hs, -0.005 * hs)
        jw.loft([R(0.0, 0.060 * hs * jwid, 0.068 * hs, 0, -0.006 * hs),
                 R(-0.035 * hs * jl, 0.058 * hs * jwid, 0.066 * hs, 0, -0.012 * hs),
                 R(-0.07 * hs * jl, 0.042 * hs * jwid, 0.052 * hs, 0, -0.026 * hs),
                 R(-0.088 * hs * jl, 0.024 * hs * jwid, 0.032 * hs, 0, -0.038 * hs)],
                m["skin"], ngon(10), rel, cap0=None, cap1=0.25)
        # внутренность челюсти (язык/тень)
        jw.box(0.075 * hs * jwid, 0.08 * hs, 0.02 * hs, m["mouth"], rel @ T(0, -0.01 * hs, 0.002 * hs))
        self.jaw_face(jw, rel)
        jw.build(head, jaw_piv, self.head_piv)
        self.hair(head)

    def teeth(self, part, M, count, ax, ay, oy, z, up, size, fang_idx=(), mat=None, spread=1.05):
        """Зубы — четырёхгранные клинья со скошенными кончиками, по дуге."""
        mat = mat or self.m["teeth"]
        for i in range(count):
            t = (i / (count - 1) - 0.5) * 2 * spread
            x = math.sin(t) * ax
            y = -math.cos(t) * ay + oy
            sz = size * (1.9 if i in fang_idx else 1.0) * (1 + self.rnd.uniform(-0.15, 0.2))
            rings = [R(0.0, 0.0055 * sz / size * size / 0.02, 0.0045), R(sz * 0.55, 0.004 * sz / 0.02, 0.0034),
                     R(sz, 0.0016, 0.0014)]
            rot = Rz(-t) @ (Matrix() if up else Rx(pi))
            part.loft(rings, mat, ngon(4), M @ T(x, y, z) @ rot @ Rx(self.rnd.uniform(-0.15, 0.15)),
                      cap0=None, cap1=0.5)

    def eye(self, part, x, z, r, mat, pupil=None, pupil_r=0.25, bulge=1.0, yaw=0.0, socket=None, socket_s=1.6,
            lid=None):
        hs = self.p["head_s"]
        y = self.face_y(x, z)
        s = 1 if x > 0 else -1
        yaw = yaw or s * 0.32
        M = T(x, y, z) @ Rz(yaw)
        if socket:
            part.loft([R(-0.01, r * socket_s, r * socket_s * 0.8), R(0.004 * hs, r * socket_s * 0.95, r * socket_s * 0.75)],
                      socket, ngon(8), M @ FWD, cap0=None, cap1=None)
        part.loft([R(-0.008, r * 0.9), R(0.004 * bulge, r), R(0.011 * bulge, r * 0.8)], mat, ngon(8), M @ FWD,
                  cap0=None, cap1=0.25)
        if pupil:
            tip = 0.011 * bulge + r * 0.8 * 0.25
            part.loft([R(0.0, r * pupil_r), R(0.0022, r * pupil_r * 0.8)], pupil, ngon(6),
                      M @ T(0, -tip + 0.0012, 0) @ FWD, cap0=None, cap1=0.2)
        if lid:
            for k, dz in ((1, 0.8), (-1, -0.85)):
                part.loft([R(-r * 1.1, 0.004, 0.006), R(0.0, 0.007, 0.009), R(r * 1.1, 0.004, 0.006)], lid, CHSQ,
                          M @ T(0, -0.004 * bulge, dz * r) @ Ry(pi / 2) @ Rx(-k * 0.35), cap0=0.4, cap1=0.4)

    def nose(self, part, z_top, z_tip, w, out, mat, nostril=None):
        y = self.face_y(0, z_tip)
        rings = [R(z_top, w * 0.35, w * 0.25, 0, y + 0.003), R((z_top + z_tip) / 2, w * 0.6, w * 0.45, 0, y - out * 0.5),
                 R(z_tip + 0.006, w, w * 0.7, 0, y - out), R(z_tip, w * 0.8, w * 0.55, 0, y - out * 0.6)]
        part.loft(rings, mat, WEDGE, cap0=0.3, cap1=0.3)
        if nostril:
            for s in (-1, 1):
                part.box(w * 0.5, 0.006, 0.006, nostril, T(s * w * 0.42, y - out * 0.55, z_tip - 0.001) @ Rz(s * 0.4))

    # переопределяется монстрами
    def face(self, hd):
        pass

    def jaw_face(self, jw, rel):
        pass

    def hair(self, head):
        pass

    def strand(self, part, theta, z0, length, width, mat, out0=0.0, out1=0.06, fwd=0.0, sway=0.0, rough=0.0,
               head_r=None, segs=6, curl=0.0):
        """Прядь волос — плоская угловая пластина, сужающаяся к скошенному кончику."""
        hs = self.p["head_s"]
        ax = 0.082 * hs * self.p["head_w"] if head_r is None else head_r[0]
        ay = 0.1 * hs if head_r is None else head_r[1]
        rings = []
        rnd = self.rnd
        for k in range(segs + 1):
            t = k / segs
            o = out0 + (out1 - out0) * (1 - (1 - t) ** 2)
            w = width * (1 - 0.75 * t ** 1.5)
            rings.append(R(-t * length, w, w * 0.22, sway * math.sin(t * 2.2) + rnd.uniform(-rough, rough),
                           -o - fwd * t + curl * t * t + rnd.uniform(-rough, rough) * 0.5))
        root = (math.sin(theta) * ax, -math.cos(theta) * ay + 0.01 * hs, z0)
        part.loft(rings, mat, ngon(6), T(*root) @ Rz(theta), cap0=0.3, cap1=0.6)

    def hair_cap(self, part, mat, front_lift=0.32, scale=1.07, low=0.06):
        rings = [r for r in self.head_rings() if r["z"] >= low * self.p["head_s"]]
        for r in rings:
            r["rx"] *= scale
            r["ry"] *= scale
            r["oy"] += 0.008
        part.loft(rings, mat, ngon(10), T(0, 0.012, 0.0) @ Rx(-front_lift), cap0=0.0001, cap1=0.3)


# ================================================================ МОНСТРЫ ==
class Peeker(Humanoid):
    """«Соглядатай»: лысый, морщинистый, выпученные глаза, пасть клыков."""

    def face(self, hd):
        m, hs = self.m, self.p["head_s"]
        # тяжёлые надбровные дуги — пластины под углом
        for s in (-1, 1):
            x = s * 0.04 * hs
            hd.loft([R(-0.03, 0.009, 0.012), R(0.0, 0.012, 0.016), R(0.03, 0.008, 0.012)], m["skin"], CHSQ,
                    T(x, self.face_y(x, 0.118 * hs) + 0.002, 0.118 * hs) @ Rz(s * 0.3) @ Ry(pi / 2) @ Rx(s * 0.15),
                    cap0=0.5, cap1=0.5)
        # морщины на лбу: ряды узких пластин, повторяющих изгиб черепа
        for row in range(4):
            z = (0.142 + row * 0.022) * hs
            for k in range(-2, 3):
                ang = k * 0.36 + self.rnd.uniform(-0.04, 0.04)
                x = math.sin(ang) * 0.07 * hs
                y = self.face_y(x, z) + 0.0015
                L = 0.034 * hs * self.rnd.uniform(0.8, 1.1)
                M = T(x, y, z + abs(k) * 0.004 * hs) @ Rz(ang) @ Ry(self.rnd.uniform(-0.1, 0.1))
                hd.box(L, 0.007, 0.006, m["skin"], M)                       # складка
                hd.box(L * 0.9, 0.004, 0.0025, m["skin_dark"], M @ T(0, 0.0015, -0.0045))  # тень под складкой
        # впалые щёки и скулы
        for s in (-1, 1):
            x = s * 0.055 * hs
            hd.box(0.03, 0.012, 0.035, m["skin_dark"], T(x, self.face_y(x, 0.03 * hs) + 0.004, 0.03 * hs) @ Rz(s * 0.6))
            x2 = s * 0.06 * hs
            hd.box(0.035, 0.012, 0.014, m["skin"], T(x2, self.face_y(x2, 0.065 * hs) - 0.002, 0.065 * hs) @ Rz(s * 0.55) @ Ry(s * 0.2))
        # глаза навыкате с крошечным зрачком и веками
        for s in (-1, 1):
            self.eye(hd, s * 0.036 * hs, 0.088 * hs, 0.02 * hs, m["eye"], pupil=m["pupil"], pupil_r=0.3, bulge=1.6,
                     socket=m["skin_dark"], socket_s=1.45, lid=m["skin"])
        self.nose(hd, 0.08 * hs, 0.036 * hs, 0.017 * hs, 0.016, m["skin"], nostril=m["mouth"])
        # верхняя губа и ряд клыков
        y = self.face_y(0, 0.0)
        hd.loft([R(0.0, 0.058 * hs, 0.012), R(0.012, 0.06 * hs, 0.014)], m["skin_dark"], CHSQ,
                T(0, y + 0.012, -0.004 * hs), cap0=0.3, cap1=0.3)
        self.teeth(hd, Matrix(), 13, 0.047 * hs, 0.062 * hs, -0.006 * hs, -0.006 * hs, False, 0.017 * hs,
                   fang_idx=(2, 3, 9, 10), spread=1.25)

    def jaw_face(self, jw, rel):
        m, hs = self.m, self.p["head_s"]
        self.teeth(jw, rel, 12, 0.044 * hs, 0.058 * hs, -0.008 * hs, -0.006 * hs, True, 0.015 * hs,
                   fang_idx=(1, 2, 9, 10), spread=1.2)
        # нижняя губа и складки подбородка
        jw.loft([R(0.0, 0.05 * hs, 0.01), R(0.01, 0.052 * hs, 0.012)], m["skin_dark"], CHSQ,
                rel @ T(0, -0.062 * hs, -0.02 * hs), cap0=0.3, cap1=0.3)
        for k in range(3):
            jw.box(0.05 - k * 0.012, 0.006, 0.006, m["skin_dark"],
                   rel @ T(0, -0.055 * hs + k * 0.006, (-0.045 - k * 0.012) * hs) @ Rx(0.3))

    def hair(self, head):
        # несколько жидких прядей на затылке
        pass  # лысый


class Pale(Humanoid):
    """«Бледная»: белые слепые глаза, синяки глазниц, тёмный провал рта, чёрные волосы."""

    def face(self, hd):
        m, hs = self.m, self.p["head_s"]
        for s in (-1, 1):
            self.eye(hd, s * 0.034 * hs, 0.09 * hs, 0.017 * hs, m["eye"], bulge=0.8, socket=m["bruise"], socket_s=1.75)
            # нижнее веко-мешок
            x = s * 0.036 * hs
            hd.box(0.03, 0.01, 0.01, m["bruise"], T(x, self.face_y(x, 0.066 * hs) - 0.001, 0.066 * hs) @ Rz(s * 0.32) @ Ry(s * 0.15))
        self.nose(hd, 0.085 * hs, 0.042 * hs, 0.014 * hs, 0.011, m["skin"], nostril=m["mouth"])
        # трещины/вены — тонкие тёмные пластины
        for i in range(6):
            ang = self.rnd.uniform(-1.0, 1.0)
            z = self.rnd.uniform(0.1, 0.2) * hs
            ax, ay = 0.08 * hs, 0.097 * hs
            hd.box(0.02, 0.003, 0.0025, m["bruise"],
                   T(math.sin(ang) * ax, -math.cos(ang) * ay + 0.008, z) @ Rz(ang) @ Ry(self.rnd.uniform(-1.2, 1.2)))
        y = self.face_y(0, 0.0)
        hd.loft([R(0.0, 0.03 * hs, 0.008), R(0.008, 0.032 * hs, 0.009)], m["bruise"], CHSQ, T(0, y + 0.008, 0.0),
                cap0=0.3, cap1=0.3)
        self.teeth(hd, Matrix(), 8, 0.032 * hs, 0.055 * hs, -0.006 * hs, -0.004 * hs, False, 0.009 * hs,
                   spread=0.9, mat=m["teeth"])

    def jaw_face(self, jw, rel):
        pass

    def hair(self, head):
        m, hs = self.m, self.p["head_s"]
        hp = Part("Hair")
        self.hair_cap(hp, m["hair"], front_lift=0.38)
        rnd = self.rnd
        # длинные прямые пряди: сзади и по бокам, часть падает на лицо
        for i in range(34):
            th = rnd.uniform(1.0, 2 * pi - 1.0)
            side = abs(math.sin(th))
            front = math.cos(th) > 0
            L = rnd.uniform(0.55, 0.85) if not front else rnd.uniform(0.45, 0.7)
            self.strand(hp, th, rnd.uniform(0.16, 0.22) * hs, L, rnd.uniform(0.014, 0.022), m["hair"],
                        out0=0.004, out1=0.03 + 0.07 * side, fwd=0.05 if front else -0.02, sway=0.012, rough=0.004,
                        segs=7)
        # пряди, частично закрывающие лицо
        for th in (-0.62, -0.5, 0.52, 0.66):
            self.strand(hp, th, 0.215 * hs, rnd.uniform(0.35, 0.55), 0.013, m["hair"], out0=0.004, out1=0.02,
                        fwd=0.03, sway=0.01, rough=0.003, segs=7)
        hp.build(head, self.head_piv, self.head_piv)


class Screamer(Humanoid):
    """«Крикунья»: чёрные провалы глаз с искрой зрачка и огромный кричащий рот."""

    def face(self, hd):
        m, hs = self.m, self.p["head_s"]
        for s in (-1, 1):
            self.eye(hd, s * 0.035 * hs, 0.09 * hs, 0.009 * hs, m["eye"], bulge=0.5, socket=m["socket"], socket_s=3.2)
        self.nose(hd, 0.08 * hs, 0.04 * hs, 0.013 * hs, 0.009, m["skin"], nostril=m["mouth"])
        # верхняя губа, растянутая криком
        y = self.face_y(0, 0.0)
        hd.loft([R(0.0, 0.045 * hs, 0.01), R(0.01, 0.047 * hs, 0.011)], m["socket"], CHSQ, T(0, y + 0.01, -0.006),
                cap0=0.3, cap1=0.3)
        # морщины крика на переносице
        for k in range(3):
            hd.box(0.022, 0.004, 0.004, m["socket"], T(0, self.face_y(0, (0.105 + k * 0.01) * hs) - 0.001, (0.105 + k * 0.01) * hs))

    def jaw_face(self, jw, rel):
        m, hs = self.m, self.p["head_s"]
        jw.loft([R(0.0, 0.04 * hs, 0.01), R(0.01, 0.042 * hs, 0.012)], m["socket"], CHSQ,
                rel @ T(0, -0.058 * hs, -0.02 * hs), cap0=0.3, cap1=0.3)

    def hair(self, head):
        m, hs = self.m, self.p["head_s"]
        hp = Part("Hair")
        self.hair_cap(hp, m["hair"], front_lift=0.3, scale=1.09)
        rnd = self.rnd
        # спутанные пряди: торчат, загибаются, разной длины
        for i in range(40):
            th = rnd.uniform(0.35, 2 * pi - 0.35)
            side = abs(math.sin(th))
            front = math.cos(th) > 0.3
            self.strand(hp, th, rnd.uniform(0.12, 0.23) * hs, rnd.uniform(0.2, 0.42) if not front else rnd.uniform(0.15, 0.3),
                        rnd.uniform(0.016, 0.026), m["hair"], out0=0.006, out1=rnd.uniform(0.04, 0.12) * (0.4 + side),
                        fwd=0.04 if front else 0.0, sway=rnd.uniform(-0.05, 0.05), rough=0.012, segs=6,
                        curl=rnd.uniform(-0.04, 0.04))
        hp.build(head, self.head_piv, self.head_piv)


class Crawler(Pale):
    """«Ползущая»: изломанная фигура в белом, ползёт на четвереньках."""

    def hair(self, head):
        m, hs = self.m, self.p["head_s"]
        hp = Part("Hair")
        self.hair_cap(hp, m["hair"], front_lift=0.2, scale=1.08, low=0.05)
        rnd = self.rnd
        # волосы падают вперёд и закрывают почти всё лицо (голова наклонена в позе)
        for i in range(44):
            th = rnd.uniform(-pi, pi)
            if -0.3 < th < 0.42:
                continue  # щель в волосах — сквозь неё смотрит один глаз
            front = math.cos(th) > 0.2
            self.strand(hp, th, rnd.uniform(0.17, 0.235) * hs, rnd.uniform(0.45, 0.75), rnd.uniform(0.016, 0.024), m["hair"],
                        out0=0.004, out1=0.02 + 0.05 * abs(math.sin(th)), fwd=0.05 if front else 0.0, sway=0.015,
                        rough=0.005, segs=7)
        hp.build(head, self.head_piv, self.head_piv)


def pose_crawler(objs):
    """Базовая поза «на четвереньках» — сохраняется в узлах glTF, сайт анимирует поверх неё."""
    o = objs
    o["Hips"].location.z = 0.57
    o["Hips"].rotation_euler = (math.radians(74), 0, 0)
    o["Spine"].rotation_euler = (math.radians(6), 0, 0)
    o["Neck"].rotation_euler = (math.radians(-50), 0, 0)
    o["Head"].rotation_euler = (math.radians(-28), 0, math.radians(18))
    o["Jaw"].rotation_euler = (math.radians(22), 0, 0)
    for s, side in ((1, "L"), (-1, "R")):
        o["UpperArm." + side].rotation_euler = (math.radians(-112), 0, math.radians(s * 28))
        o["Forearm." + side].rotation_euler = (math.radians(28), 0, 0)
        o["Hand." + side].rotation_euler = (math.radians(60), 0, 0)
        o["Thigh." + side].rotation_euler = (math.radians(-80), math.radians(s * 18), 0)
        o["Shin." + side].rotation_euler = (math.radians(96), 0, 0)


# ================================================================ ОПИСАНИЯ ==
BASE = dict(hip_z=0.95, hip_w=1.0, torso_w=1.0, torso_len=0.55, neck_len=0.1, neck_w=1.0, head_s=1.0, head_w=1.0,
            jaw_len=1.0, upper_arm=0.31, forearm=0.29, arm_w=1.0, hand=0.08, finger=0.085, curl=0.25, claw=0.012,
            thigh=0.45, robe=False, robe_w=1.0, seed=1)


def mats_for(key):
    if key == "peeker":
        sk = material("Skin", "#8c6a44", 0.72)
        return dict(skin=sk, skin_dark=material("Crease", "#3f2b18", 0.8), eye=material("Eye", "#e6dcb8", 0.25, emit=0.18),
                    pupil=material("Pupil", "#0b0705", 0.3), teeth=material("Teeth", "#d9c79c", 0.45),
                    mouth=material("Mouth", "#140303", 0.9), shirt=material("Shirt", "#1d1b19", 0.95),
                    sleeve=material("Sleeve", "#1d1b19", 0.95), pants=material("Pants", "#16130f", 0.95),
                    legs=material("Legs", "#16130f", 0.95),
                    claw=material("Claw", "#2b2013", 0.5), hair=material("Hair", "#2a2420", 0.9),
                    robe=material("Robe", "#16130f", 0.95))
    if key in ("pale", "crawler"):
        sk = material("Skin", "#b9b6b0" if key == "pale" else "#c7c4bd", 0.8)
        dress = material("Dress", "#3d3b39" if key == "pale" else "#d6d2c8", 0.95)
        return dict(skin=sk, skin_dark=material("Crease", "#6d5f62", 0.8), bruise=material("Bruise", "#45262f", 0.85),
                    eye=material("Eye", "#eef6f6", 0.3, emit=1.6), mouth=material("Mouth", "#040202", 1.0),
                    teeth=material("Teeth", "#8d8775", 0.6), shirt=dress, sleeve=dress, pants=dress, legs=sk,
                    claw=material("Claw", "#4a3f3a", 0.5), hair=material("Hair", "#060607", 0.78),
                    robe=dress, pupil=material("Pupil", "#000000"))
    if key == "screamer":
        sk = material("Skin", "#959c8d", 0.8)
        gown = material("Gown", "#c4c1b3", 0.95)
        return dict(skin=sk, skin_dark=material("Crease", "#4d5248", 0.8), socket=material("Socket", "#030303", 1.0),
                    eye=material("Eye", "#f2fff2", 0.2, emit=6.0), mouth=material("Mouth", "#020202", 1.0),
                    teeth=material("Teeth", "#9a937d", 0.6), shirt=gown, sleeve=gown, pants=gown, legs=sk,
                    claw=material("Claw", "#3a3a33", 0.5), hair=material("Hair", "#5f513f", 0.8), robe=gown)
    raise KeyError(key)


MONSTERS = {
    "peeker": (Peeker, dict(hip_z=0.98, torso_len=0.56, torso_w=0.92, neck_len=0.11, neck_w=0.8, head_s=1.22,
                            head_w=1.1, jaw_w=1.08, jaw_len=1.05, upper_arm=0.34, forearm=0.33, arm_w=0.8,
                            hand=0.09, finger=0.12, curl=0.35, claw=0.022, ribs=False, tendons=True, cuffs=True,
                            seed=7)),
    "pale": (Pale, dict(hip_z=0.92, torso_len=0.52, torso_w=0.88, hip_w=0.92, neck_len=0.1, head_s=0.98, head_w=0.95,
                        jaw_len=1.05, finger=0.1, curl=0.2, claw=0.01, robe=True, robe_w=0.95, robe_hem=0.04,
                        collar=True, seed=3)),
    "screamer": (Screamer, dict(hip_z=0.9, torso_len=0.5, torso_w=0.86, hip_w=0.9, neck_len=0.09, head_s=1.0,
                                head_w=0.96, jaw_len=1.4, finger=0.1, curl=0.45, claw=0.012, robe=True, robe_w=0.9,
                                robe_hem=0.3, collar=True, seed=11)),
    "crawler": (Crawler, dict(hip_z=0.9, torso_len=0.52, torso_w=0.86, hip_w=0.9, neck_len=0.12, neck_w=0.85,
                              head_s=0.98, head_w=0.95, upper_arm=0.33, forearm=0.31, finger=0.11, curl=0.3,
                              claw=0.012, robe=True, robe_w=0.85, robe_hem=0.25, collar=True, seed=5)),
}


# ================================================================ РЕНДЕР ==
PREVIEW_POSES = {
    "peeker": {"Head": (8, 0, -10), "Jaw": (26, 0, 0), "UpperArm.L": (-70, 0, -10), "Forearm.L": (-50, 0, 0),
               "UpperArm.R": (-30, 0, 12), "Forearm.R": (-40, 0, 0)},
    "pale": {"Head": (10, 0, 14), "Jaw": (16, 0, 0), "UpperArm.L": (-8, 0, 0), "UpperArm.R": (-8, 0, 0)},
    "screamer": {"Head": (-8, 0, 0), "Jaw": (38, 0, 0), "UpperArm.L": (-60, 0, -35), "Forearm.L": (-60, 0, 0),
                 "UpperArm.R": (-55, 0, 30), "Forearm.R": (-65, 0, 0)},
    "crawler": {},
}

CAMS = {
    "peeker": ((0.28, -1.15, 1.92), (0.0, 0, 1.78), 50),
    "pale": ((0.2, -1.05, 1.62), (0, 0, 1.55), 50),
    "screamer": ((-0.22, -1.1, 1.55), (0, 0, 1.45), 45),
    "crawler": ((0.75, -2.5, 0.8), (0, -0.35, 0.42), 40),
}


def render_preview(key, objs, path):
    sc = bpy.context.scene
    for name, (x, y, z) in PREVIEW_POSES.get(key, {}).items():
        o = objs[name]
        o.rotation_euler = tuple(a + math.radians(b) for a, b in zip(o.rotation_euler, (x, y, z)))
    loc, tgt, lens = CAMS[key]
    if os.environ.get("FULLBODY"):
        loc, tgt, lens = ((1.6, -3.2, 1.3), (0, 0, 0.9), 35) if os.environ["FULLBODY"] == "1" else ((3.4, 0.2, 0.9), (0, 0, 0.8), 35)
    cam_d = bpy.data.cameras.new("Cam")
    cam_d.lens = lens
    cam = bpy.data.objects.new("Cam", cam_d)
    sc.collection.objects.link(cam)
    cam.location = loc
    d = Vector(tgt) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam

    def light(name, kind, pos, energy, color, size=0.3, spot=None):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if kind in ("AREA",):
            ld.size = size
        if kind == "SPOT":
            ld.spot_size = spot or 0.9
            ld.spot_blend = 0.6
            ld.shadow_soft_size = size
        lo = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(lo)
        lo.location = pos
        dd = Vector(tgt) - Vector(pos)
        lo.rotation_euler = dd.to_track_quat("-Z", "Y").to_euler()

    tx, ty, tz = tgt
    light("Key", "SPOT", (tx + 0.35, ty - 1.0, tz - 0.75), 90, (1.0, 0.78, 0.55), 0.15, 0.8)   # «фонарик» снизу
    light("Rim", "AREA", (tx - 0.6, ty + 0.9, tz + 0.6), 60, (0.45, 0.6, 1.0), 0.8)            # холодный контур
    light("Fill", "AREA", (tx - 0.8, ty - 0.8, tz + 0.2), 6, (0.6, 0.7, 0.9), 1.5)

    w = bpy.data.worlds.new("World")
    sc.world = w
    bg = w.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.004, 0.005, 0.007, 1)
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = int(os.environ.get("SAMPLES", 48))
    try:
        sc.cycles.use_denoising = True
    except Exception:
        pass
    sc.render.resolution_x = 600
    sc.render.resolution_y = 800
    sc.render.image_settings.file_format = "JPEG"
    sc.render.image_settings.quality = 85
    sc.view_settings.look = "AgX - Medium High Contrast" if "AgX - Medium High Contrast" in [
        i.identifier for i in sc.view_settings.bl_rna.properties["look"].enum_items] else "None"
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ================================================================ MAIN ==
def build(key):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cls, extra = MONSTERS[key]
    p = dict(BASE)
    p.update(extra)
    h = cls(key, p, mats_for(key))
    h.build()
    objs = {o.name: o for o in bpy.context.scene.objects}
    if key == "crawler":
        pose_crawler(objs)
    os.makedirs(OUT_MODELS, exist_ok=True)
    out = os.path.join(OUT_MODELS, key + ".glb")
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_yup=True,
                              export_animations=False, export_lights=False, export_cameras=False)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs.values() if o.type == "MESH")
    print(f"[{key}] {out}  объектов={len(objs)}  треугольников≈{tris}")
    if DO_RENDER:
        os.makedirs(OUT_IMG, exist_ok=True)
        render_preview(key, objs, os.environ.get("IMG_OUT", os.path.join(OUT_IMG, key + ".jpg")).replace("{k}", key))


if __name__ == "__main__":
    for k in (ONLY or list(MONSTERS)):
        build(k)
