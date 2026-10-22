/**
 * Cinematic holographic core. Pure Canvas2D; no textures or external assets.
 * The application owns its interactive project labels. This canvas is visual only.
 */

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wrapAngle = value => ((value + Math.PI) % TAU + TAU) % TAU - Math.PI;

function randomSequence(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

// The geometry is cached in unit space. Animation only rotates and projects it.
function sphereGeometry(small) {
  const samples = small ? 48 : 64;
  const longitudes = small ? 12 : 16;
  const latitudes = small ? 7 : 9;
  const paths = [];
  for (let index = 1; index <= latitudes; index++) {
    const latitude = -Math.PI / 2 + index * Math.PI / (latitudes + 1);
    const height = Math.sin(latitude), radius = Math.cos(latitude);
    const points = [];
    for (let step = 0; step <= samples; step++) {
      const angle = step / samples * TAU;
      points.push([radius * Math.cos(angle), height, radius * Math.sin(angle)]);
    }
    paths.push({ points, emphasis: index === (latitudes + 1) / 2 });
  }
  for (let index = 0; index < longitudes; index++) {
    const longitude = index / longitudes * TAU;
    const points = [];
    for (let step = 0; step <= samples / 2; step++) {
      const latitude = -Math.PI / 2 + step / (samples / 2) * Math.PI;
      points.push([Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude),
        Math.cos(latitude) * Math.sin(longitude)]);
    }
    paths.push({ points, emphasis: index % 4 === 0 });
  }
  return paths;
}

function orbitGeometry(radius, tilt, turn, samples) {
  const points = [];
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const cr = Math.cos(turn), sr = Math.sin(turn);
  for (let index = 0; index <= samples; index++) {
    const angle = index / samples * TAU;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * ct;
    const z = Math.sin(angle) * radius * st;
    points.push([x * cr - y * sr, x * sr + y * cr, z]);
  }
  return points;
}

function rotation(x, y, z) {
  return { cx: Math.cos(x), sx: Math.sin(x), cy: Math.cos(y), sy: Math.sin(y), cz: Math.cos(z), sz: Math.sin(z) };
}

function transform(point, matrix) {
  const y = point[1] * matrix.cx - point[2] * matrix.sx;
  const z = point[1] * matrix.sx + point[2] * matrix.cx;
  const x = point[0] * matrix.cy + z * matrix.sy;
  const depth = -point[0] * matrix.sy + z * matrix.cy;
  return [x * matrix.cz - y * matrix.sz, x * matrix.sz + y * matrix.cz, depth];
}

/**
 * @param {HTMLCanvasElement} canvas Canvas whose CSS supplies its panel size.
 * @returns {{setPaused(value:boolean):void,setFocus(index:number):void,destroy():void}}
 */
export function createHoloCore(canvas) {
  const empty = { setPaused() {}, setFocus() {}, destroy() {} };
  if (!canvas) return empty;
  let context;
  try { context = canvas.getContext('2d', { alpha: true }); } catch { /* A quiet CSS fallback is sufficient. */ }
  if (!context) {
    const background = canvas.style.background;
    canvas.style.background = 'radial-gradient(ellipse at center, rgba(33,119,173,.16), transparent 64%)';
    return { ...empty, destroy() { canvas.style.background = background; } };
  }

  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const originalHidden = canvas.getAttribute('aria-hidden');
  canvas.setAttribute('aria-hidden', 'true');
  let width = 1, height = 1, ratio = 1, small = false;
  let radius = 1, centreX = 0, centreY = 0;
  let grid = [], orbits = [], particles = [];
  let geometrySmall = null;
  let paused = false, destroyed = false;
  let frame = 0, resizeFrame = 0, lastDraw = 0, lastTick = 0, time = 0;
  let selected = 0, focusAngle = -Math.PI / 2, targetAngle = focusAngle;

  function buildGeometry() {
    grid = sphereGeometry(small);
    const samples = small ? 72 : 104;
    orbits = [
      { points: orbitGeometry(1.38, 1.04, -.44, samples), front: .37, back: .11 },
      { points: orbitGeometry(1.24, -.91, .92, samples), front: .25, back: .075 },
      { points: orbitGeometry(1.57, 1.19, 1.57, samples), front: .17, back: .055 },
    ];
    const random = randomSequence(0x8af17);
    particles = Array.from({ length: small ? 18 : 34 }, () => ({
      angle: random() * TAU,
      radius: .64 + random() * 1.18,
      size: .5 + random() * .8,
      alpha: .1 + random() * .3,
      depth: .25 + random() * .75,
      phase: random() * TAU,
    }));
    geometrySmall = small;
  }

  function project(point) {
    const perspective = 6.8 / (6.8 - point[2]);
    return [centreX + point[0] * radius * perspective,
      centreY + point[1] * radius * perspective, point[2]];
  }

  function pathStroke(paths, front, color, lineWidth, emphasizeOnly = false) {
    context.beginPath();
    for (const path of paths) {
      if (emphasizeOnly && !path.emphasis) continue;
      const points = path.points;
      let connected = false;
      for (let index = 1; index < points.length; index++) {
        const a = points[index - 1], b = points[index];
        const isFront = (a[2] + b[2]) >= 0;
        if (isFront !== front) { connected = false; continue; }
        if (!connected) context.moveTo(a[0], a[1]);
        context.lineTo(b[0], b[1]);
        connected = true;
      }
    }
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.stroke();
  }

  function drawIndex() {
    const outer = radius * 1.52;
    const tickCount = small ? 60 : 72;
    for (let index = 0; index < tickCount; index++) {
      const angle = index / tickCount * TAU - Math.PI / 2;
      const major = index % 6 === 0;
      const lit = Math.abs(wrapAngle(angle - focusAngle)) < .19;
      const inside = outer - (major ? 6 : 2.5);
      context.beginPath();
      context.moveTo(centreX + Math.cos(angle) * inside, centreY + Math.sin(angle) * inside);
      context.lineTo(centreX + Math.cos(angle) * outer, centreY + Math.sin(angle) * outer);
      context.strokeStyle = lit ? 'rgba(156,236,255,.82)' : major ? 'rgba(101,178,219,.31)' : 'rgba(76,136,180,.17)';
      context.lineWidth = lit ? 1.15 : .7;
      context.stroke();
    }

    // Broken, precisely drawn rings read as instrument framing, not a solid tube.
    const arcs = [[-.99, -.51], [.16, .69], [1.19, 1.45], [1.96, 2.55], [3.16, 3.67], [4.03, 4.27]];
    context.lineWidth = .7;
    context.strokeStyle = 'rgba(92,174,218,.24)';
    for (const [start, end] of arcs) {
      context.beginPath();
      context.arc(centreX, centreY, outer + 9, start + time * .013, end + time * .013);
      context.stroke();
    }
    context.save();
    context.strokeStyle = 'rgba(137,233,255,.86)';
    context.lineWidth = 1.35;
    context.shadowColor = '#71e7ff'; context.shadowBlur = 7;
    context.beginPath(); context.arc(centreX, centreY, outer + 3, focusAngle - .12, focusAngle + .12); context.stroke();
    context.restore();
  }

  function drawNodes() {
    for (let index = 0; index < 6; index++) {
      const angle = -Math.PI / 2 + index * TAU / 6;
      const point = project([Math.cos(angle) * .79, Math.sin(angle) * .79, .61]);
      const activeNode = index === selected;
      const size = activeNode ? 3.8 : 2.5;
      context.save();
      context.strokeStyle = activeNode ? '#b0f4ff' : 'rgba(103,197,231,.58)';
      context.fillStyle = activeNode ? 'rgba(113,231,255,.62)' : 'rgba(30,97,133,.45)';
      context.lineWidth = activeNode ? 1 : .7;
      if (activeNode) { context.shadowColor = '#71e7ff'; context.shadowBlur = 10; }
      context.fillRect(point[0] - size, point[1] - size, size * 2, size * 2);
      context.strokeRect(point[0] - size, point[1] - size, size * 2, size * 2);
      if (activeNode) {
        context.shadowBlur = 0;
        context.strokeStyle = 'rgba(113,231,255,.48)';
        context.beginPath();
        context.moveTo(point[0] - size - 5, point[1] - size - 4);
        context.lineTo(point[0] - size - 5, point[1] + size + 4);
        context.moveTo(point[0] + size + 5, point[1] - size - 4);
        context.lineTo(point[0] + size + 5, point[1] + size + 4);
        context.stroke();
      }
      context.restore();
    }
  }

  function draw() {
    if (destroyed || !grid.length) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
    context.lineCap = 'round'; context.lineJoin = 'round';

    const haze = context.createRadialGradient(centreX, centreY, radius * .2, centreX, centreY, radius * 1.85);
    haze.addColorStop(0, 'rgba(24,99,157,.10)');
    haze.addColorStop(.48, 'rgba(24,76,122,.075)');
    haze.addColorStop(1, 'rgba(5,9,22,0)');
    context.fillStyle = haze; context.fillRect(0, 0, width, height);

    for (const particle of particles) {
      const angle = particle.angle + time * .016 * particle.depth;
      const x = centreX + Math.cos(angle) * radius * particle.radius;
      const y = centreY + Math.sin(angle) * radius * particle.radius * .77;
      context.globalAlpha = particle.alpha * (.8 + .2 * Math.sin(time * .35 + particle.phase));
      context.fillStyle = '#93dfff';
      context.fillRect(x, y, particle.size, particle.size);
    }
    context.globalAlpha = 1;
    drawIndex();

    const sphereRotation = rotation(.23 + Math.sin(time * .055) * .045, .38 + time * .105, -.18);
    const projectedGrid = grid.map(path => ({
      emphasis: path.emphasis,
      points: path.points.map(point => project(transform(point, sphereRotation))),
    }));
    const orbitRotation = rotation(0, Math.sin(time * .037) * .025, Math.sin(time * .021) * .035);
    const projectedOrbits = orbits.map(orbit => ({ ...orbit,
      points: orbit.points.map(point => project(transform(point, orbitRotation))),
    }));

    for (const orbit of projectedOrbits) pathStroke([orbit], false, `rgba(76,143,194,${orbit.back})`, .7);
    pathStroke(projectedGrid, false, 'rgba(66,129,185,.17)', .65);

    // Gentle volume separates the far hemisphere from the luminous near grid.
    const shade = context.createRadialGradient(centreX - radius * .32, centreY - radius * .36,
      radius * .05, centreX, centreY, radius * 1.015);
    shade.addColorStop(0, 'rgba(47,125,164,.13)');
    shade.addColorStop(.62, 'rgba(6,31,54,.18)');
    shade.addColorStop(.92, 'rgba(4,20,39,.26)');
    shade.addColorStop(1, 'rgba(36,111,157,.13)');
    context.fillStyle = shade;
    context.beginPath(); context.arc(centreX, centreY, radius * 1.015, 0, TAU); context.fill();

    pathStroke(projectedGrid, true, 'rgba(104,216,248,.50)', .8);
    pathStroke(projectedGrid, true, 'rgba(148,235,255,.23)', .88, true);
    context.beginPath(); context.arc(centreX, centreY, radius * 1.015, 0, TAU);
    context.strokeStyle = 'rgba(111,223,251,.34)'; context.lineWidth = .75; context.stroke();

    // Selected-project illumination changes the accent only, never the geometry.
    const glowX = centreX + Math.cos(focusAngle) * radius * .78;
    const glowY = centreY + Math.sin(focusAngle) * radius * .78;
    const selectionGlow = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius * .49);
    selectionGlow.addColorStop(0, 'rgba(65,161,209,.095)');
    selectionGlow.addColorStop(1, 'rgba(65,161,209,0)');
    context.fillStyle = selectionGlow;
    context.fillRect(glowX - radius * .5, glowY - radius * .5, radius, radius);

    for (const orbit of projectedOrbits) pathStroke([orbit], true, `rgba(119,222,250,${orbit.front})`, .78);
    drawNodes();
  }

  function resize() {
    if (destroyed) return;
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width || 580));
    height = Math.max(1, Math.round(bounds.height || 450));
    small = width <= 420 || height <= 320;
    ratio = Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.5, Math.sqrt(1100000 / (width * height)));
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    centreX = width * .5; centreY = height * .5;
    radius = Math.min(width * .247, height * .285);
    if (geometrySmall !== small) buildGeometry();
    draw();
  }

  function active() { return !destroyed && !paused && !reduced?.matches && !document.hidden; }
  function tick(now) {
    frame = 0;
    if (!active()) return;
    const interval = 1000 / 24;
    if (now - lastDraw >= interval) {
      time += Math.min((now - lastTick) / 1000, .12);
      lastTick = now;
      lastDraw = now - (now - lastDraw) % interval;
      focusAngle += wrapAngle(targetAngle - focusAngle) * .18;
      draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function refresh() {
    if (active()) {
      if (!frame) { lastTick = performance.now(); frame = requestAnimationFrame(tick); }
    } else {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      focusAngle = targetAngle;
      if (!destroyed && !document.hidden) draw();
    }
  }
  function scheduleResize() {
    if (destroyed || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); });
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleResize) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', scheduleResize, { passive: true });
  document.addEventListener('visibilitychange', refresh);
  reduced?.addEventListener?.('change', refresh);

  // Canvas2D retains its synchronously painted first frame through immediate pause.
  resize(); refresh();
  return {
    setPaused(value) { paused = Boolean(value); refresh(); },
    setFocus(index) {
      const number = Number(index);
      if (!Number.isFinite(number) || destroyed) return;
      selected = ((Math.trunc(number) % 6) + 6) % 6;
      targetAngle = -Math.PI / 2 + selected * TAU / 6;
      if (!active()) focusAngle = targetAngle;
      // An explicit selection remains visible while motion is disabled.
      if (!document.hidden) draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleResize);
      document.removeEventListener('visibilitychange', refresh);
      reduced?.removeEventListener?.('change', refresh);
      grid = []; orbits = []; particles = [];
      if (originalHidden === null) canvas.removeAttribute('aria-hidden');
      else canvas.setAttribute('aria-hidden', originalHidden);
    },
  };
}
