// The picture renderer (WebGL2): one engine for the preview and the export, as drone.js is for the sound.
// A frame is the current image (inverted or not, zoomed about the centre) with, after a cut, the previous one mixed over it (the Trail).
// The numbers are the export's (cutplan.py) so frames keep their look: mono = 1 - luma (601, as Pillow's "L"), the trail a plain mix,
// the zoom a crop of the centre 1/scale. Images fill the frame (cover). Pixels are worked on as stored (sRGB values, no colour management),
// like Pillow, so a frame here and the frame Pillow made from the same plate agree within a level or two.
(() => {
  const VS = `#version 300 es
  in vec2 aPos; out vec2 vUv;
  void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uCur, uGhost;
  uniform vec2 uCoverCur, uCoverGhost;
  uniform float uScaleCur, uScaleGhost, uAlpha;
  uniform int uInvCur, uInvGhost;
  vec3 look(sampler2D s, vec2 cover, float scale, int inv) {
    vec3 c = texture(s, 0.5 + (vUv - 0.5) * cover / scale).rgb;
    if (inv == 2) c = vec3(1.0 - dot(c, vec3(0.299, 0.587, 0.114)));     // grey: Pillow's L, inverted
    else if (inv == 1) c = 1.0 - c;                                       // colour
    return c;
  }
  void main() {
    vec3 c = look(uCur, uCoverCur, uScaleCur, uInvCur);
    if (uAlpha > 0.0) c = mix(c, look(uGhost, uCoverGhost, uScaleGhost, uInvGhost), uAlpha);
    outColor = vec4(c, 1.0);
  }`;
  const INV = { off: 0, colour: 1, mono: 2 };

  // canvas: an HTMLCanvasElement or OffscreenCanvas. null when WebGL2 is not there (the page then draws with CSS).
  function create(canvas, opts = {}) {
    let gl = null;
    try { gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: !!opts.keep }); } catch (e) { gl = null; }
    if (!gl) return null;
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    for (const n of ['uCur', 'uGhost', 'uCoverCur', 'uCoverGhost', 'uScaleCur', 'uScaleGhost', 'uAlpha', 'uInvCur', 'uInvGhost']) U[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(U.uCur, 0); gl.uniform1i(U.uGhost, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);      // the file's values, as Pillow reads them

    // one texture per image, the most recent kept (a full-size plate is ~20 MB on the GPU with its mipmaps: the export keeps few)
    const textures = new Map(), keepN = opts.textures || 48;
    function texture(key, img) {
      let t = textures.get(key);
      if (t) { textures.delete(key); textures.set(key, t); return t; }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);                                   // a big plate drawn small stays smooth
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t = { tex, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
      textures.set(key, t);
      while (textures.size > keepN) { const [k, old] = textures.entries().next().value; gl.deleteTexture(old.tex); textures.delete(k); }
      return t;
    }
    // the part of the image that fills the frame (object-fit: cover)
    const cover = (t, w, h) => { const a = (t.w / t.h) / (w / h); return a > 1 ? [1 / a, 1] : [1, a]; };

    // f = { cur: { key, img, invert: 'off'|'colour'|'mono', scale }, ghost: { key, img, invert, scale, alpha } | null }
    function draw(f) {
      const w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      const cur = texture(f.cur.key, f.cur.img);
      const g = f.ghost && f.ghost.alpha > 0 ? f.ghost : null, ghost = g ? texture(g.key, g.img) : cur;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ghost.tex);
      gl.uniform2fv(U.uCoverCur, cover(cur, w, h)); gl.uniform2fv(U.uCoverGhost, cover(ghost, w, h));
      gl.uniform1f(U.uScaleCur, Math.max(1, f.cur.scale || 1)); gl.uniform1f(U.uScaleGhost, g ? Math.max(1, g.scale || 1) : 1);
      gl.uniform1i(U.uInvCur, INV[f.cur.invert] || 0); gl.uniform1i(U.uInvGhost, g ? INV[g.invert] || 0 : 0);
      gl.uniform1f(U.uAlpha, g ? Math.min(1, g.alpha) : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function forget() { for (const t of textures.values()) gl.deleteTexture(t.tex); textures.clear(); }
    return { draw, forget, gl, canvas };
  }

  // a full-size image, decoded (the export draws from these)
  async function loadImage(url) { const im = new Image(); im.src = url; await im.decode(); return im; }

  window.Render = { create, loadImage };
})();
