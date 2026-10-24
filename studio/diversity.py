"""
Random shot seeds across independent axes (no fixed categories).

Each shot is a random combination of subject x material x setting x light x camera x logo treatment x color world.
Recently used values are avoided so consecutive batches don't orbit the same space.
"""

import random

SUBJECTS = [
    "a hand holding a transparent glass slab", "a monolithic extruded letterform sculpture", "a hardcover monograph standing on its spine",
    "a floating smartphone", "an oversized hoodie on a hanger", "a stack of folded garments", "a fashion portrait with a high collar",
    "a pair of leather gloves", "a ceramic vessel", "a perfume bottle", "a vinyl record sleeve", "a wristwatch movement",
    "a rolled steel coil", "an espresso machine detail", "a skate deck", "a chef's knife on a stone", "a trading card",
    "a paper shopping bag", "a bicycle bell", "a studio loudspeaker grille", "a ceiling-mounted architectural light",
    "a wind-polished boulder", "a lone tree on a hill", "a still pond", "a sand dune ridge", "a frozen waterfall",
    "a stairwell seen from above", "a concrete brutalist atrium", "a revolving door", "an empty gallery wall",
    "a billboard on a rooftop", "a subway platform sign", "a shipping container yard", "a lighthouse lens",
    "a hospital corridor", "a greenhouse interior", "a rooftop water tank", "a parking structure ramp",
    "a pair of hands pressing clay", "a wax seal", "a rubber stamp impression", "a circuit board macro",
    "a telescope mirror", "a stack of acrylic sheets", "a glass of water on a table", "a folded paper sculpture",
    "an embossed leather book cover", "a woven textile loom", "a neon tube bender's bench", "a foundry mold",
    "a hot-stamped foil card", "a rack of vinyl-wrapped tubes", "a cassette shell", "a pill blister pack",
    "a giant inflatable object", "a shoe on a plinth", "a sunglasses lens", "a cutting mat with blade",
    # apparel & wearables
    "a cropped puffer jacket collar", "a knit beanie with a folded cuff", "a denim jacket back panel", "a cargo pant pocket flap",
    "a woven label sewn into a seam", "a leather belt buckle", "a canvas tote bag", "a sneaker toe box", "a silk scarf in motion",
    "a varsity jacket chest", "a ribbed sock cuff", "a pleated skirt in wind", "a technical shell jacket zipper garage",
    # outdoor displays & signage
    "a stadium scoreboard LED panel", "a highway gantry sign at night", "a bus-stop lightbox in rain", "a painted brick wall mural",
    "a rooftop neon sign", "a pedestrian crossing stencil", "a flip-dot display board", "a giant LED cube in a plaza",
    "a split-flap departure board", "a cinema marquee", "a shop-window vinyl lettering", "a drone-light show in the night sky",
    # on-screen / digital
    "a macro of an OLED phone screen", "a laptop screen in a dark room", "a CRT with scanlines", "a smartwatch face",
    "a wall of surveillance monitors", "a vintage computer terminal with phosphor glow", "a tablet showing a drawing app",
    "a car dashboard display", "an e-ink reader page", "a pixelated game screen", "a video-call grid on a monitor",
    "a smart-home panel on a wall", "a camera viewfinder overlay", "a loading spinner on a huge screen",
    # nature
    "a moss-covered boulder", "a fern unrolling", "a tide pool at low tide", "a canyon wall with striations", "a lightning field",
    "a spider web with dew", "a bioluminescent bay", "a field of tall grass in wind", "an aurora over a frozen lake",
    "a cross-section of a tree trunk", "a cave opening with a light shaft", "a close-up of a leaf's veins", "a murmuration of birds",
    "a geyser basin", "a lava crust cracking", "a cloud inversion over a valley", "a coral reef shallows", "wet river stones",
]

MATERIALS = [
    "mirror chrome", "frosted glass", "clear cast acrylic", "matte black rubber", "brushed aluminum", "raw board-formed concrete",
    "polished travertine", "white porcelain", "anodized aluminum", "satin silk", "heavy cotton canvas", "perforated steel",
    "translucent resin", "carbon fiber twill", "blown glass", "lacquered wood", "oxidized copper", "wet clay",
    "paper pulp", "cast iron", "terrazzo", "ribbed corduroy", "liquid mercury", "soft-touch silicone",
    "ferrofluid", "frosted ice", "sandblasted stone", "gel-coated fiberglass", "neoprene", "LED mesh",
    "holographic foil", "ceramic glaze", "knitted wool", "embossed leather", "etched brass", "latex balloon skin",
]

SETTINGS = [
    "seamless studio sweep", "empty gallery", "overcast coastline", "wet night street", "desert at noon", "snowfield",
    "concrete bunker", "glass atrium", "foggy forest edge", "rooftop at dusk", "industrial warehouse", "clean laboratory",
    "tiled swimming pool", "airport gate", "private library", "hotel corridor", "salt flat", "volcanic beach",
    "parking garage", "quiet suburban lawn", "fabric showroom", "dark void", "mirrored room", "sunlit stairwell",
]

LIGHTING = [
    "soft overhead softbox", "hard raking sunlight", "single hard flash with deep shadow", "overcast flat daylight",
    "backlit rim glow", "neon spill", "blue hour ambient", "volumetric fog beams", "specular strip lights",
    "candlelit warm pool", "caustic water reflections", "high-key white studio", "low-key chiaroscuro",
    "gel-colored split light", "projector light cutting through haze", "dappled leaf shadow",
]

CAMERAS = [
    "straight-on symmetrical, 50mm", "macro, shallow depth of field", "low angle looking up, wide lens",
    "top-down flat lay", "slight isometric three-quarter, long lens", "telephoto compression", "tilt-shift miniature feel",
    "wide architectural, perfectly vertical lines", "over-the-shoulder close crop", "frame-filling extreme close-up",
]

LOGO_TREATMENTS = [
    "debossed into the surface", "extruded 3D in the same material", "etched with glowing edges", "stitched or embroidered",
    "printed in a single flat ink", "negative space cut-out revealing what is behind", "a hole of light",
    "foil-stamped with a metallic sheen", "formed by the arrangement of small objects", "projected light on the surface",
    "inflated or padded relief", "engraved with fine linework", "a reflection or shadow shape", "grown or carved organic form",
    "pixel or dot matrix", "a lens or glass refraction shape",
]

COLOR_WORLDS = [
    "monochrome black and white with a single electric-blue accent (#5D8FF4)",
    "violet-blue and black, high contrast",
    "warm cream (#FEFFE7) and burnt orange (#EC540C)",
    "oxblood (#381313) and hot pink (#F64570)",
    "pale grey and silver, almost no saturation",
    "deep forest green and cream",
    "saturated orange field with black",
    "pastel gradient haze, grainy",
    "ink black with a single cream mark",
    "cool blue-grey fog, desaturated",
    "sunset orange, pink and blue grainy aura",
    "all-white on white tonal",
]

TEXTURES = [
    "ferrofluid spikes", "drifting smoke", "ink clouds in water", "embers and sparks", "oil-film iridescence", "condensation beads", "rippling water", "fine sand grains",
    "suspended dust in light", "frozen splash droplets", "foam bubbles", "lightning filaments", "steam wisps", "molten glow", "caustic light patterns", "wet reflective surface",
    "visible fabric weave", "fine film grain and halation", "brushed metal anisotropic streaks", "orange-peel lacquer", "pitted concrete with bug holes",
    "cracked dried mud", "frost crystals", "fogged glass with droplets", "matte paper fibers", "pixel grid visible at macro",
    "knurled metal", "wet asphalt sheen", "moss and lichen", "ribbed rubber", "embossed leather grain", "scratched acrylic",
    "peeling paint layers", "woven wicker", "perforated mesh moire", "stippled halftone dots", "ripples on water", "sand ripples",
    "velvet pile catching light", "ceramic crazing", "sandblasted frosted glass", "carbon twill", "terry cloth loops", "soap film iridescence",
    "oil slick rainbow", "chipped enamel", "bark furrows", "basalt columns",
]

AXES = {
    "subject": SUBJECTS, "material": MATERIALS, "texture": TEXTURES, "setting": SETTINGS, "lighting": LIGHTING,
    "camera": CAMERAS, "logo": LOGO_TREATMENTS, "color": COLOR_WORLDS,
}


def sample_shots(count: int, recent: dict | None = None) -> list[dict]:
    """Random axis combinations. `recent` maps axis -> list of recently used values to avoid."""
    recent = recent or {}
    shots = []
    used = {a: set(recent.get(a, [])) for a in AXES}
    for _ in range(count):
        shot = {}
        for axis, pool in AXES.items():
            fresh = [v for v in pool if v not in used[axis]] or pool
            shot[axis] = random.choice(fresh)
            used[axis].add(shot[axis])
        shots.append(shot)
    return shots


def describe(shot: dict) -> str:
    return (
        f"subject: {shot['subject']}; material: {shot['material']}; surface texture: {shot['texture']}; setting: {shot['setting']}; "
        f"light: {shot['lighting']}; camera: {shot['camera']}; logo treatment: {shot['logo']}; palette: {shot['color']}"
    )
