"""
Creative worlds for the Demo film.

Demo is a creative toolkit for creatives at an agency group, so the range of worlds is the point:
every discipline a creative works in. But each world is authored like a design-studio identity (think Pentagram):
one idea, a restrained palette, rigorous type and grid, one bold gesture, and the mark behaving intelligently in application.

A batch commits to ONE world so shots inside it cohere (like Moverunion: one palette, one material language),
and every world has a dark and a light register so shots pair and cut like Soiltone's color/mono alternation.
"""

import random

# Neutrals are always allowed. Accents are chosen per world; at most 3 colors in a frame.
WORLDS = [
    {
        "name": "Editorial Print",
        "weight": 0.5,
        "brief": "Swiss-grid editorial design: oversized grotesk type, hairline rules, uncoated stock, folded posters, risograph overprint. One bold typographic or color-block gesture per frame.",
        "palette": "warm cream #FEFFE7 and ink #1A1A1A with a single burnt orange #EC540C accent",
        "applications": [
            "a poster folded in quarters pinned to a wall", "an open magazine spread with a giant cropped numeral", "a stack of risograph prints with misregistered overprint",
            "a hardcover monograph spine and edge", "a letterpress business card pressed deep into thick stock", "a perforated tear-off ticket sheet",
            "a newspaper page with one inked block", "a book cover embossed blind", "a bound zine with a stapled spine", "a stack of coated paper sample swatches",
        ],
        "marks": ["blind-embossed into the stock", "a die-cut hole revealing the next page", "foil-stamped", "a single flat ink overprint", "the negative space between two color blocks"],
    },
    {
        "name": "Packaging & Product",
        "weight": 0.6,
        "brief": "Premium product and packaging photography: one object on a seamless sweep, perfect edges, tactile finishes, calm confidence.",
        "palette": "stone grey, matte black, and one signal color (burnt orange #EC540C or electric blue #5D8FF4)",
        "applications": [
            "a matte black box with a magnetic lid", "a glass perfume bottle and cap", "a pill-shaped aluminum canister", "a tube of paint half squeezed",
            "a folded paper bag with a rope handle", "a cardboard mailer box with a tear strip", "a spray can with a soft-touch finish", "a ceramic cup and saucer",
            "a cassette tape in clear shell", "a velvet-lined jewelry box", "a tin of mints", "a bottle cap macro",
        ],
        "marks": ["debossed into the lid", "printed in a single spot color", "laser-etched metal", "a foil seal", "the label's die-cut window"],
    },
    {
        "name": "Fashion & Apparel",
        "weight": 1.2,
        "brief": "Fashion editorial and technical apparel: tonal garments, tailored fabric detail, hardware, model-light. Tactile and quiet, never costume.",
        "palette": "tonal black, bone white and one electric accent from the brand",
        "applications": [
            "a heavy hoodie chest with drawstrings", "a puffer jacket collar close-up", "a knit beanie with a folded cuff", "a leather glove on a fist",
            "a denim jacket back panel", "a sneaker toe box and lace", "a cargo pocket flap with a zip", "a woven neck label inside a collar",
            "a model in a tall technical collar and tinted glasses", "a silk scarf caught in wind", "a canvas tote hanging on a hook", "a varsity jacket chest",
        ],
        "marks": ["embroidered tone-on-tone in raised satin thread", "a woven label", "a rubberized patch", "a reflective print catching a flash", "knitted into the fabric"],
    },
    {
        "name": "Out-of-Home & City",
        "weight": 0.7,
        "brief": "Brand identity in the city: billboards, transit, wayfinding, flags and murals, photographed with a real sense of scale and weather.",
        "palette": "concrete grey, sky blue and black with one saturated brand color",
        "applications": [
            "a rooftop billboard against a dusk sky", "a bus-shelter lightbox in rain", "a highway gantry sign at night", "a flag on a pole against a blue sky",
            "a wheatpasted poster wall peeling at the edges", "a split-flap departure board", "a cinema marquee with bulbs", "a shop-window with vinyl lettering",
            "a painted brick mural", "a stadium scoreboard LED panel", "a pedestrian crossing with a stencilled mark", "a drone-light formation in the night sky",
        ],
        "marks": ["the whole billboard face", "a stencil on asphalt", "bulbs forming the shape", "a mural painted by hand", "a flip-dot pattern"],
    },
    {
        "name": "Screen & Interface",
        "weight": 1.3,
        "brief": "Screens as material: OLED macros, phosphor, motion-design frames, product UI. Pixel structure and glow are the texture.",
        "palette": "OLED black, cool white, and one glowing brand color",
        "applications": [
            "an OLED phone screen in a dark hand", "a CRT monitor with scanlines and phosphor bloom", "a smartwatch face on a wrist", "a wall of monitors in a control room",
            "a car dashboard display at night", "an e-ink reader page", "a laptop in a dark room lighting a face", "a pixel-art game screen on an arcade cabinet",
            "a video-call grid on a monitor", "a camera viewfinder overlay", "an LED-matrix panel at macro", "a loading animation on a giant plaza screen",
        ],
        "marks": ["rendered as the UI's own loading mark", "glowing pixels", "scanned onto the phosphor", "a cursor-sized icon enlarged", "a notification-style badge"],
    },
    {
        "name": "Film & Broadcast",
        "weight": 0.7,
        "brief": "The language of cinema and broadcast: lenses, light, film stock, marquee and control-room. Cinematic restraint, one motivated light source.",
        "palette": "projector black, tungsten amber and a deep teal",
        "applications": [
            "a cine lens front element with a reflection", "a clapperboard", "a strip of 35mm film held to light", "a projector beam through dust",
            "a studio monitor in a dark gallery", "an anamorphic flare across a frame", "a call sheet taped to a wall", "a tripod and cinema camera in a white cyc",
            "a director's chair in an empty stage", "a broadcast test-card on a CRT", "a microphone with a foam windscreen", "a rolled movie poster",
        ],
        "marks": ["a flare shaped by the aperture", "the lens iris itself", "burned into the film frame", "a gobo projected on a wall", "the test-card's central circle"],
    },
    {
        "name": "Sound & Music",
        "weight": 0.9,
        "brief": "Sound made visible and tactile: speakers, vinyl, tape, waveforms, cymatics. Rhythm, repetition, vibration.",
        "palette": "vinyl black, copper and cream",
        "applications": [
            "a vinyl record with a center label", "a loudspeaker cone with a dust cap", "a mixing console fader row", "a reel-to-reel tape",
            "a sand plate vibrating into cymatic patterns", "a headphone cup in leather", "a waveform printed on paper", "a drum head with a stick",
            "a modular synth patch cable cluster", "a brass horn bell at macro",
        ],
        "marks": ["the record label", "the speaker's dust cap", "the cymatic node pattern", "a waveform shaped into the mark", "a knob's indicator ring"],
    },
    {
        "name": "Architecture & Space",
        "weight": 1.0,
        "brief": "Architectural photography and exhibition design: light as material, monumental simplicity, human scale.",
        "palette": "raw concrete, white plaster and a single warm sun color",
        "applications": [
            "a brutalist concrete wall with a diagonal sunbeam", "a stairwell seen from above", "a skylight over an empty gallery", "a perforated metal facade at dusk",
            "a revolving glass door", "a curved plaster wall in soft light", "an exhibition plinth with a spotlight", "a corridor of repeated arches",
            "a pool tiled in grid with water caustics", "a ribbed concrete ceiling", "a glass block wall", "a monumental stone doorway",
        ],
        "marks": ["a hole of light through the wall", "a shadow cast by a cutout", "a deep deboss in concrete", "water caustics forming it", "the oculus itself"],
    },
    {
        "name": "Nature & Light",
        "weight": 1.2,
        "brief": "Nature photographed with a designer's eye: the mark emerges through physics, never pasted. Quiet, large-scale, patient light.",
        "palette": "deep forest, bone and one amber or blue light",
        "applications": [
            "cracked black ice lit from below", "a forest canopy opening to a sky", "a tide pool at low tide", "a raked zen sand garden",
            "an aurora over a frozen lake", "a moss-covered boulder", "a spider web with dew at dawn", "a dune ridge at low sun", "a canyon wall with striations",
            "a field of tall grass in wind", "a cave opening with a light shaft", "a cross-section of a tree trunk",
        ],
        "marks": ["a hole of light beneath ice", "the negative space of a canopy", "a ripple pattern", "raked lines in sand", "growth rings"],
    },
    {
        "name": "Craft & Materials",
        "weight": 1.1,
        "brief": "Hand-made and material-led: ceramics, glass, wax, cast metal, textile, folded paper. The beauty of the process and the imperfection.",
        "palette": "clay, bone and a single mineral color",
        "applications": [
            "a wet clay vessel on a wheel", "blown glass catching a flame", "a wax seal being pressed", "molten metal poured into a mold", "a loom with woven threads",
            "a folded paper sculpture", "pressed botanicals on vellum", "a terrazzo slab being polished", "a carved stone relief", "a stained glass window in a church",
        ],
        "marks": ["pressed into the wet clay", "the seal's impression", "cut through the folded paper", "cast in the metal", "leaded into the glass"],
    },
    {
        "name": "Type & Lettering",
        "weight": 1.0,
        "brief": "Letterforms as architecture and object: specimens, sign-painting, neon, stencils, metal type. The mark is treated like a glyph in a family.",
        "palette": "ink black, paper white and one process color",
        "applications": [
            "metal type blocks in a letterpress drawer", "a type specimen sheet with a single enormous glyph", "a neon tube sign being bent", "a sign-painter's gold leaf lettering on glass",
            "a stencil spray-painted on a wall", "a cut vinyl letter on a shopfront", "a wooden type case", "a monumental carved inscription in stone",
            "an inflatable letter sculpture in a plaza", "cut-out paper letters on a table",
        ],
        "marks": ["the glyph in a specimen grid", "a neon tube bent into it", "a gold-leaf mark on glass", "a stencil", "a monumental inscription"],
    },
    {
        "name": "People & Gesture",
        "weight": 0.7,
        "brief": "Human presence and motion: hands, faces, bodies, light on skin. Candid and cinematic, always designed so the frame could start a video.",
        "palette": "skin tones against one saturated brand color and black",
        "applications": [
            "a hand holding a thin glass slab", "a dancer's blurred silhouette against a colored wall", "a face lit by a phone in the dark", "a hand pressing clay",
            "a close portrait with tinted glasses and a high collar", "hands holding a printed poster open", "a silhouette in a doorway of light", "a runner on a track seen from above",
            "a hand reaching into a beam of projected light", "a crowd's raised phones at a concert",
        ],
        "marks": ["projected onto skin or fabric", "reflected in the glasses", "formed by the negative space between hands", "a painted mark on a wall behind", "a glowing object held in the hand"],
    },
    {
        "name": "Retail & Hospitality",
        "weight": 0.3,
        "brief": "Brand in the hand: matchboxes, cups, menus, keycards, shopfronts. Small, specific, beautifully made.",
        "palette": "paper, brass and one red or orange",
        "applications": [
            "a paper coffee cup with a sleeve", "a matchbox with a striker panel", "a hotel keycard in a slot", "a menu on a linen tablecloth", "a shopfront at dusk with a blade sign",
            "a ceramic ashtray", "a bakery paper bag", "a receipt roll", "a wine label on a bottle", "a glass door with gold lettering",
        ],
        "marks": ["a gold-foil stamp", "a die-cut sleeve", "the matchbox striker", "hot-stamped into leather", "etched in the door glass"],
    },
    {
        "name": "Sport & Culture",
        "weight": 0.3,
        "brief": "The energy of sport and live culture: stadiums, tickets, kit, courts, arcades. Fast, graphic, high-contrast.",
        "palette": "court green or track red, white and black",
        "applications": [
            "a jersey chest with mesh texture", "a ticket stub with a perforation", "a stadium floodlight against night sky", "a basketball court center circle from above",
            "a running track lane numbers", "a championship belt buckle", "a scoreboard LED", "an arcade cabinet marquee", "a swimming lane rope and tiled floor",
        ],
        "marks": ["the center circle of the court", "a perforated ticket stub", "woven into the mesh", "the lane marking", "an LED matrix pattern"],
    },
    {
        "name": "Precision & Drafting",
        "weight": 1.3,
        "brief": "The language of precision: construction geometry, dimension lines, cyanotype, vellum, instruments. Rigorous, quiet, beautiful. Always rendered as a considered design object with real paper, light and shadow, never a flat diagram.",
        "palette": "dark register: matte black or oxblood with copper and cream linework; light register: cream vellum or cyanotype blue with ink and a single orange accent",
        "applications": [
            "a cyanotype sheet with compass arcs and a lamp shadow", "a matte black drafting sheet with copper dimension lines and a caliper", "a cream drafting sheet with tangent construction circles in raking light",
            "tracing paper layered over a grid under a desk lamp", "protractor and brass dividers on vellum", "a blueprint with folded creases under side light",
            "an X-ray of a watch mechanism glowing on a lightbox", "orbit diagrams scribed into black acrylic", "a brass sextant in haze", "dimension callouts etched into anodized aluminum",
        ],
        "marks": ["a construction-circle diagram that resolves into the mark", "the intersection of tangent arcs", "a scribed groove catching light", "an X-ray glow", "the circular field of an instrument"],
    },
    {
        "name": "Orbital & Radial",
        "weight": 2.5,
        "brief": "The mark is an orbit, so find orbits and radial structure in the real world: eclipses, star trails, apertures, lenses, grooves, turbines, mechanisms, whirlpools. Calm symmetric compositions with one still center and energy around it. Hyper-real, photographed with scale and awe.",
        "palette": "dark register: space black with copper, amber or ice-blue light; light register: bone and silver with graphite and one cobalt accent",
        "applications": [
            "a total solar eclipse corona over a dark horizon", "star trails circling a pole over a dark landscape", "a planet's limb glowing at the edge of space", "a lens flare ring across a dark frame",
            "a telescope primary mirror reflecting a tiny sky", "a lighthouse Fresnel lens glowing at dusk", "a crescent moon rising over a calm sea", "a vinyl record groove at macro with a single light reflection",
            "a turbine fan seen head-on", "a camera iris aperture half closed", "a watch escapement and balance wheel", "a gyroscope spinning on a dark surface",
            "a drain vortex in a white basin", "milk stirred into black tea forming a spiral galaxy", "an orrery of brass rings", "a satellite dish seen from directly below",
        ],
        "marks": ["the eclipse's ring of light", "the aperture opening", "the groove's reflection circle", "a planet's ring", "the hole at the iris of a mechanism", "the vortex center"],
    },
    {
        "name": "Micro & Mineral",
        "weight": 2.5,
        "brief": "The very small and the very old: biology under the microscope, minerals and stone cross-sections. Concentric and radial natural patterns with a still center. Macro photography and dark-field microscopy, tactile and quiet.",
        "palette": "dark register: black with luminous amber, teal or violet light; light register: bone, pale stone and graphite with one mineral accent",
        "applications": [
            "a human eye iris in extreme macro", "a petri dish with colonies growing in a ring", "pollen grains on a dark surface at macro", "mycelium spreading radially across dark soil",
            "a cell dividing under dark-field microscopy", "a geode cross-section with crystal rings", "marble veining swirling around a hole", "tree rings in a polished cross-section",
            "a polished agate slice with concentric bands", "a radiolarian under a microscope", "a salt flat polygon pattern with a round puddle", "obsidian volcanic glass reflecting a window",
            "a dandelion seed head backlit", "a nautilus shell in cross-section", "frost ringing a leaf", "a slice of citrus with radial segments in backlight",
        ],
        "marks": ["the iris and pupil", "concentric mineral bands", "a colony ring in a petri dish", "a crystal-lined hollow", "tree rings", "the seed head's center"],
    },
    {
        "name": "Matter & Elements",
        "weight": 3.0,
        "brief": "Matter in motion, photographed like a physicist-artist: fluids, magnetism, smoke, fire, water, light and dust. The mark is never added; it emerges from the physics (a vortex, a void, a ring of ripples, field lines, a smoke ring, an interference ring). Macro or large-scale, hyper-real, dramatic, quiet.",
        "palette": "dark register: deep black with luminous amber, ember orange, electric blue or hot pink emitted light; light register: bone white and graphite with one cobalt or orange accent",
        "applications": [
            "ferrofluid spikes rising from a black pool", "iron filings tracing a magnetic field around a magnet", "ink blooming in clear water", "smoke rising in a still dark room",
            "steam curling off a dark surface in raking light", "embers drifting upward from a fire", "molten glass pouring in a thin stream", "oil film on water with rainbow interference",
            "a soap bubble wall at macro with swirling color", "sand falling through a shaft of light", "dust motes in a beam of light in a dark hall", "a splash frozen mid-air against black",
            "foam and bubbles on dark liquid", "lightning branching across a night sky", "a plasma globe's glowing filaments", "a milk-drop crown frozen against black",
            "two paints mixing in a clear tank", "mercury beads rolling together", "frost crystals growing across black glass", "a wave curling backlit at dawn",
            "magma crust cracking with orange light beneath", "a candle flame's blue core in darkness", "a smoke ring drifting in a spotlight", "wet sand ripples at low tide in low sun",
            "a prism splitting a beam into a spectrum on a wall", "a whirlpool seen from directly above", "a tornado funnel seen from above in a dark field", "wind rippling tall grass in a circle", "a single drop hitting still water at macro", "lava lamp wax rising in warm light", "a vortex of leaves in autumn light", "water caustics over a pale wall", "powdered pigment exploding in the air",
        ],
        "marks": [
            "the vortex or void at the center of the flow", "a ring of ripples", "magnetic field lines", "a smoke ring or the negative space in the smoke", "a bubble film's interference ring",
            "a ring-shaped flame or ember halo", "the circular opening between two fluids", "a caustic highlight forming it", "a splash crown", "a lightning-lit circular clearing",
        ],
    },
]


def all_worlds(st: dict) -> list[dict]:
    """Built-in worlds plus wildcard worlds Kimi invented that have earned their place."""
    out = list(WORLDS)
    names = {w["name"] for w in out}
    for w in st.get("custom_worlds", []):
        if w["name"] in names:
            continue
        stats = world_stats(st).get(w["name"], {"n": 0, "kept": 0})
        if stats["n"] >= 6 and stats["kept"] == 0:
            continue  # flopped: never kept anything, retire it
        out.append(w)
    return out


def world_stats(st: dict) -> dict:
    """Per world: n generated, kept (still in the grid), and a smoothed keep rate."""
    trashed = set(st.get("trashed", []))
    qa_failed = set(st.get("qa_failed", []))
    stats: dict = {}
    for filename, name in st.get("worlds", {}).items():
        s = stats.setdefault(name, {"n": 0, "kept": 0, "qa": 0})
        s["n"] += 1
        if filename not in trashed:
            s["kept"] += 1
        elif filename in qa_failed:
            s["qa"] += 1
    for s in stats.values():
        # qa-failed plates are a weak negative: count them as half an observation
        eff_n = s["n"] - 0.5 * s["qa"]
        s["rate"] = (s["kept"] + 1) / (eff_n + 6)  # prior ~ 1/6 pulls small samples to the middle
    return stats


def choose_world(st: dict, mode: str = "") -> dict | None:
    """
    mode '' = surprise me, a world name = that world, '__wildcard__' / '__custom__' = None (caller invents a new world; custom is built from the director's text).
    Surprise: 50% exploit by keep rate (floored), 30% explore the least-sampled, 20% wildcard.
    """
    worlds = all_worlds(st)
    if mode in ("__wildcard__", "__custom__"):
        return None
    for w in worlds:
        if w["name"] == mode:
            return w
    recent = st.get("recent_worlds", [])[-3:]
    pool = [w for w in worlds if w["name"] not in recent] or worlds
    stats = world_stats(st)
    r = random.random()
    if r < 0.2:
        return None
    if r < 0.5:
        least = min(stats.get(w["name"], {"n": 0})["n"] for w in pool)
        return random.choice([w for w in pool if stats.get(w["name"], {"n": 0})["n"] <= least + 2])
    weights = [max(0.05, stats.get(w["name"], {"rate": 0.17})["rate"]) for w in pool]
    return random.choices(pool, weights=weights, k=1)[0]
