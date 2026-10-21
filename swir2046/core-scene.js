/**
 * SWIR / orbital core — procedural WebGL artwork, with no runtime dependencies.
 * Mount into a canvas whose parent supplies width and height.
 * A Canvas2D rendering keeps the composition intact when WebGL is unavailable.
 */

const VERTEX = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * .5 + .5;
  gl_Position = vec4(a_position, 0., 1.);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 v_uv;
uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform float u_time;

const float PI = 3.14159265359;

mat2 rot(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 local(vec3 p) {
  p.xy = rot(-.34 + .055 * sin(u_time * .18)) * p.xy;
  p.yz = rot(.41 + u_pointer.y * .13) * p.yz;
  p.xz = rot(-.47 + sin(u_time * .22) * .18 + u_pointer.x * .14) * p.xz;
  return p;
}

// A gently deformed solid-metal ring, plus a separate pair of orbital paths.
vec2 scene(vec3 p) {
  vec3 q = local(p);
  float a = atan(q.y, q.x);
  float wave = sin(a * 3. + u_time * .19);
  float radius = 1.025 + .055 * wave;
  float tube = .265 + .035 * cos(a * 3. - .4);
  vec2 crossSection = vec2(length(q.xy) - radius, q.z + .075 * wave);
  float body = length(crossSection) - tube;
  vec2 result = vec2(body, 1.);

  vec3 o = q;
  o.yz = rot(.88) * o.yz;
  o.xz = rot(.2) * o.xz;
  float orbit = length(vec2(length(o.xy) - 1.53, o.z)) - .012;
  if (orbit < result.x) result = vec2(orbit, 2.);

  vec3 i = q;
  i.xz = rot(-.3) * i.xz;
  i.yz = rot(-.4) * i.yz;
  float inner = length(vec2(length(i.xy) - .61, i.z)) - .018;
  // A gap makes the inner orbit feel like a deliberate mechanical component.
  inner = max(inner, min(i.x + .16, -i.y + .08));
  if (inner < result.x) result = vec2(inner, 3.);
  return result;
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(.0016, -.0016);
  return normalize(
    e.xyy * scene(p + e.xyy).x + e.yyx * scene(p + e.yyx).x +
    e.yxy * scene(p + e.yxy).x + e.xxx * scene(p + e.xxx).x
  );
}

// Studio reflection cards: long white ribbons with blue and cyan edge light.
vec3 environment(vec3 r) {
  vec3 color = vec3(.015, .028, .055);
  float white = exp(-pow((r.y - .52) * 7.5, 2.));
  white *= .28 + .72 * smoothstep(-.65, .3, r.x);
  color += vec3(.78, .9, 1.) * white * 1.15;
  float blue = exp(-pow((r.x + .64) * 7., 2.));
  color += vec3(.015, .15, 1.) * blue * .92;
  float cyan = exp(-pow((r.y + .56) * 10., 2.));
  color += vec3(.05, .9, 1.2) * cyan * .75;
  float slim = exp(-pow((r.x - .71) * 26., 2.));
  color += vec3(.58, .8, .94) * slim * .72;
  color += vec3(.07, .13, .23) * pow(max(0., r.z), 3.);
  return color;
}

void main() {
  vec2 uv = (v_uv - .5) * 2.;
  uv.x *= u_resolution.x / max(1., u_resolution.y);
  vec3 ro = vec3(0., 0., 4.9);
  vec3 rd = normalize(vec3(uv, -3.15));

  // A soft, dark-blue light pool; no opaque rectangular background.
  float radial = length(uv * vec2(.83, 1.));
  vec3 color = vec3(.008, .019, .038);
  color += vec3(.0, .055, .12) * exp(-radial * radial * 3.1);
  color += vec3(.01, .09, .15) * exp(-pow((radial - .68) * 5., 2.)) * .3;

  // Sparse, stable pinpoints add depth without becoming a particle dashboard.
  vec2 grid = uv * 45.;
  vec2 cell = floor(grid);
  vec2 center = fract(grid) - .5;
  float seed = hash(cell);
  float star = (1. - smoothstep(.015, .062, length(center))) * step(.986, seed);
  color += vec3(.25, .57, .7) * star * (.3 + .2 * sin(u_time * .45 + seed * 40.));

  // Restrict expensive marching to the sculpture's bounding sphere.
  float b = dot(ro, rd);
  float c = dot(ro, ro) - 2.89;
  float discriminant = b * b - c;
  float distance = 0.;
  float material = 0.;
  bool hit = false;
  if (discriminant > 0.) {
    float root = sqrt(discriminant);
    distance = max(0., -b - root);
    float end = -b + root;
    for (int stepIndex = 0; stepIndex < 76; stepIndex++) {
      vec2 s = scene(ro + rd * distance);
      if (s.x < .0015) { hit = true; material = s.y; break; }
      distance += s.x * .78;
      if (distance > end) break;
    }
  }

  if (hit) {
    vec3 p = ro + rd * distance;
    vec3 n = normalAt(p);
    vec3 reflected = reflect(rd, n);
    vec3 q = local(p);
    float angle = atan(q.y, q.x);
    float facing = max(0., dot(n, -rd));
    float fresnel = pow(1. - facing, 3.);
    float diffuse = max(0., dot(n, normalize(vec3(-.4, .8, 1.5))));
    vec3 reflection = environment(reflected);

    // Almost-black chromium in shadow, silver-blue along the studio light cards.
    color = vec3(.014, .033, .063) * (.32 + diffuse * .55);
    color += reflection * (.55 + .45 * fresnel);
    color += vec3(.04, .18, .32) * fresnel * .5;
    float rim = pow(1. - facing, 7.);
    color += vec3(.16, .64, .88) * rim * .5;

    // Thin etched channels wrap around the metal. The light pulse is restrained.
    float section = atan(q.z + .075 * sin(angle * 3. + u_time * .19),
      length(q.xy) - 1.025 - .055 * sin(angle * 3. + u_time * .19));
    float seam = 1. - smoothstep(.018, .04, abs(sin(section * 3. + .35)));
    float pulse = .35 + .65 * pow(.5 + .5 * cos(angle - u_time * .32), 6.);
    color += vec3(.015, .6, .85) * seam * pulse * .45;

    // Small machined segments give the solid ring a scale cue.
    float segment = 1. - smoothstep(.015, .035, abs(sin(angle * 16.)));
    color *= 1. - segment * .16;

    if (material > 1.5 && material < 2.5) {
      color = vec3(.08, .45, .68) * (.4 + diffuse * .7);
      color += vec3(.4, .85, 1.) * pow(facing, 4.) * .36;
    }
    if (material > 2.5) {
      color = vec3(.14, .88, 1.1) * (.6 + facing * .35);
    }
  }

  // Subtle glow at the hollow core preserves the sculpture's negative space.
  float coreGlow = exp(-dot(uv, uv) * 44.);
  color += vec3(.01, .06, .08) * coreGlow;
  color = color / (color + vec3(.72));
  color = pow(max(color, vec3(0.)), vec3(.84));
  float alpha = 1. - smoothstep(.8, 1.2, radial);
  gl_FragColor = vec4(color, alpha);
}`;

function fallback(canvas) {
  let context;
  try { context = canvas.getContext('2d'); } catch { /* Existing WebGL context. */ }
  if (!context) {
    canvas.style.background = 'radial-gradient(ellipse at center, rgba(33,117,198,.22), transparent 65%)';
    canvas.style.borderRadius = '50%';
    return () => {};
  }
  const draw = () => {
    const bounds = canvas.getBoundingClientRect();
    const size = Math.max(1, Math.min(bounds.width || 640, bounds.height || 640));
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round((bounds.width || size) * scale);
    canvas.height = Math.round((bounds.height || size) * scale);
    const w = canvas.width, h = canvas.height, r = Math.min(w, h) * .28;
    context.clearRect(0, 0, w, h);
    const glow = context.createRadialGradient(w / 2, h / 2, r * .4, w / 2, h / 2, r * 1.9);
    glow.addColorStop(0, '#19a3e322'); glow.addColorStop(.65, '#063a6b20'); glow.addColorStop(1, '#063a6b00');
    context.fillStyle = glow; context.fillRect(0, 0, w, h);
    context.save(); context.translate(w / 2, h / 2); context.rotate(-.45);
    context.scale(.82, 1);
    const metal = context.createLinearGradient(-r, -r, r, r);
    metal.addColorStop(0, '#bcebf6'); metal.addColorStop(.17, '#274a74');
    metal.addColorStop(.36, '#08182e'); metal.addColorStop(.47, '#258ad1');
    metal.addColorStop(.55, '#d1f7ff'); metal.addColorStop(.67, '#134374');
    metal.addColorStop(.88, '#071323'); metal.addColorStop(1, '#56d4ef');
    context.strokeStyle = metal; context.lineWidth = r * .46;
    context.shadowColor = '#24b5e56b'; context.shadowBlur = 20 * scale;
    context.beginPath(); context.arc(0, 0, r, 0, Math.PI * 2); context.stroke();
    context.shadowBlur = 0; context.lineWidth = scale;
    context.strokeStyle = '#6be5ff99'; context.beginPath();
    context.ellipse(0, 0, r * 1.55, r * .57, .65, 0, Math.PI * 2); context.stroke();
    context.strokeStyle = '#54d8efcc'; context.lineWidth = scale * 2;
    context.beginPath(); context.arc(0, 0, r * .53, .2, Math.PI * 1.65); context.stroke();
    context.restore();
  };
  draw();
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
  observer?.observe(canvas);
  return () => observer?.disconnect();
}

/** @param {HTMLCanvasElement} canvas */
export function initCoreScene(canvas) {
  if (!canvas) return { setPaused() {}, destroy() {} };
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let gl;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'low-power',
      // Paused/reduced-motion artwork is an actual retained still, including
      // when an iframe is first laid out or its compositor surface is recreated.
      // The existing 960px/DPR cap also bounds this retained color buffer.
      preserveDrawingBuffer: true,
    });
  } catch { /* Use the static illustration below. */ }
  if (!gl) {
    const cleanup = fallback(canvas);
    return { setPaused() {}, destroy: cleanup };
  }

  const shaders = [];
  let program, buffer;
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader); throw new Error('Orbital shader unavailable');
      }
      shaders.push(shader);
    }
    program = gl.createProgram();
    shaders.forEach(shader => gl.attachShader(program, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Orbital shader link unavailable');
    gl.useProgram(program);
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  } catch {
    shaders.forEach(shader => gl.deleteShader(shader));
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    // A canvas cannot switch context type; replace only its artwork surface.
    const replacement = document.createElement('canvas');
    replacement.className = canvas.className;
    replacement.style.cssText = canvas.style.cssText;
    replacement.setAttribute('aria-hidden', 'true');
    replacement.style.width = '100%'; replacement.style.height = '100%';
    canvas.hidden = true; canvas.insertAdjacentElement('afterend', replacement);
    const cleanup = fallback(replacement);
    return { setPaused() {}, destroy() { cleanup(); replacement.remove(); canvas.hidden = false; } };
  }

  const resolution = gl.getUniformLocation(program, 'u_resolution');
  const pointer = gl.getUniformLocation(program, 'u_pointer');
  const time = gl.getUniformLocation(program, 'u_time');
  const target = { x: 0, y: 0 };
  const position = { x: 0, y: 0 };
  let paused = false, intersecting = true, destroyed = false, contextLost = false;
  let frame = 0, stillFrame = 0, lastFrame = 0, elapsed = 0;
  let lastTick = performance.now();
  const mobile = window.matchMedia('(max-width: 700px)').matches;
  const fps = mobile ? 24 : 30;

  function sizeSurface() {
    if (destroyed || contextLost) return;
    const box = canvas.getBoundingClientRect();
    const width = box.width || 640, height = box.height || 640;
    // Cap both pixel density and the long edge: predictable mobile GPU use.
    const ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1.05 : 1.25, 960 / Math.max(width, height));
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    // Assigning even an unchanged canvas dimension clears its backing store.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function requestStillFrame() {
    if (destroyed || contextLost || stillFrame) return;
    // This request is independent of the animation loop. An immediate pause
    // must not cancel the first visible frame or a resize's replacement frame.
    stillFrame = requestAnimationFrame(() => {
      stillFrame = 0;
      if (destroyed || contextLost || document.hidden) return;
      sizeSurface();
      render();
    });
  }

  function resize() {
    sizeSurface();
    requestStillFrame();
  }

  function render() {
    if (destroyed || contextLost) return;
    position.x += (target.x - position.x) * .06;
    position.y += (target.y - position.y) * .06;
    gl.uniform2f(resolution, canvas.width, canvas.height);
    gl.uniform2f(pointer, position.x, position.y);
    gl.uniform1f(time, elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function active() {
    return !destroyed && !contextLost && !paused && !motion.matches && intersecting && !document.hidden;
  }

  function tick(now) {
    frame = 0;
    if (!active()) return;
    if (now - lastFrame >= 1000 / fps) {
      elapsed += Math.min((now - lastTick) / 1000, .1);
      lastTick = now; lastFrame = now;
      render();
    }
    frame = requestAnimationFrame(tick);
  }

  function refresh() {
    if (active()) {
      if (!frame) { lastTick = performance.now(); frame = requestAnimationFrame(tick); }
    } else {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!document.hidden && intersecting) requestStillFrame();
    }
  }

  function move(event) {
    if (event.pointerType === 'touch' || motion.matches || paused) return;
    const box = canvas.getBoundingClientRect();
    target.x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1));
    target.y = Math.max(-1, Math.min(1, (event.clientY - box.top) / box.height * 2 - 1));
  }
  function leave() { target.x = 0; target.y = 0; }
  function lost(event) { event.preventDefault(); contextLost = true; refresh(); }
  // A restored context has invalidated every GL resource; preserve the fallback
  // instead of spinning an animation loop against unusable GPU objects.
  function restored() {
    contextLost = true;
    canvas.style.background = 'radial-gradient(ellipse, rgba(39,142,214,.2), transparent 66%)';
  }

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  const intersectionObserver = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
    intersecting = entries[0].isIntersecting; refresh();
  }, { rootMargin: '60px' }) : null;
  resizeObserver?.observe(canvas);
  intersectionObserver?.observe(canvas);
  canvas.addEventListener('pointermove', move, { passive: true });
  canvas.addEventListener('pointerleave', leave, { passive: true });
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  document.addEventListener('visibilitychange', refresh);
  motion.addEventListener?.('change', refresh);
  resize(); refresh();

  return {
    setPaused(value) { paused = Boolean(value); refresh(); },
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      if (stillFrame) cancelAnimationFrame(stillFrame);
      resizeObserver?.disconnect(); intersectionObserver?.disconnect();
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      document.removeEventListener('visibilitychange', refresh);
      motion.removeEventListener?.('change', refresh);
      shaders.forEach(shader => gl.deleteShader(shader));
      gl.deleteBuffer(buffer); gl.deleteProgram(program);
    },
  };
}
