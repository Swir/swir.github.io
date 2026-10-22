/**
 * ORBIT / procedural cosmic wallpaper.
 * Canvas2D only. All expensive atmosphere/noise work is cached on resize.
 * The planet is shaded as a sphere with a far-side sun, not a decorative ring.
 */

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const mix = (a, b, amount) => a + (b - a) * amount;

function randomSequence(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function lattice(x, y) {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ 14719;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy);
  return mix(mix(lattice(ix, iy), lattice(ix + 1, iy), fx),
    mix(lattice(ix, iy + 1), lattice(ix + 1, iy + 1), fx), fy);
}

function cloudNoise(x, y) {
  return noise(x, y) * .59 + noise(x * 2.17 + 19.2, y * 2.17 - 3.4) * .28
    + noise(x * 4.61 - 8.5, y * 4.61 + 7.1) * .13;
}

function surface(width, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function wash(context, x, y, radius, stops) {
  const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
  for (const [position, color] of stops) gradient.addColorStop(position, color);
  context.fillStyle = gradient;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function makeBackground(width, height, ratio, mobile) {
  const layer = surface(width * ratio, height * ratio);
  const context = layer.getContext('2d');
  if (!context) return layer;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const base = context.createLinearGradient(0, 0, width * .75, height);
  base.addColorStop(0, '#050916');
  base.addColorStop(.52, '#060c1c');
  base.addColorStop(1, '#070d20');
  context.fillStyle = base; context.fillRect(0, 0, width, height);

  // Wide, faint light pools: the UI owns contrast, the wallpaper supplies depth.
  wash(context, width * .81, height * .26, Math.max(width * .43, height * .66), [
    [0, 'rgba(27,82,139,.25)'], [.48, 'rgba(15,39,82,.14)'], [1, 'rgba(5,9,22,0)'],
  ]);
  wash(context, width * .63, height * .9, Math.max(width * .48, height * .52), [
    [0, 'rgba(37,48,125,.19)'], [.55, 'rgba(22,39,91,.07)'], [1, 'rgba(5,9,22,0)'],
  ]);

  // A low-resolution noise field becomes a soft, diagonal interstellar cloud.
  // It is created once, never evaluated per animation frame.
  const cloudWidth = mobile ? 128 : 240;
  const cloudHeight = Math.max(64, Math.round(cloudWidth * height / width));
  const clouds = surface(cloudWidth, Math.min(cloudHeight, 300));
  const cloudContext = clouds.getContext('2d');
  if (cloudContext) {
    const pixels = cloudContext.createImageData(clouds.width, clouds.height);
    for (let y = 0; y < clouds.height; y++) {
      for (let x = 0; x < clouds.width; x++) {
        const u = x / clouds.width, v = y / clouds.height;
        const turbulence = cloudNoise(u * 3.9, v * 3.1);
        const belt = v - (.91 - u * .45) + (turbulence - .5) * .24;
        const density = Math.exp(-belt * belt * 48) * Math.pow(turbulence, 2.2);
        const rightBias = .12 + .88 * Math.pow(u, .7);
        const offset = (y * clouds.width + x) * 4;
        pixels.data[offset] = 50 + turbulence * 20;
        pixels.data[offset + 1] = 85 + turbulence * 46;
        pixels.data[offset + 2] = 160 + turbulence * 55;
        pixels.data[offset + 3] = density * rightBias * 83;
      }
    }
    cloudContext.putImageData(pixels, 0, 0);
    context.save();
    context.globalCompositeOperation = 'screen';
    context.imageSmoothingEnabled = true;
    context.drawImage(clouds, 0, 0, width, height);
    context.restore();
    clouds.width = 1; clouds.height = 1;
  }

  // Darken the desktop's centre-left; no bright clouds behind primary content.
  const readingShade = context.createLinearGradient(0, 0, width, 0);
  readingShade.addColorStop(0, 'rgba(2,5,13,.36)');
  readingShade.addColorStop(.4, 'rgba(2,5,13,.18)');
  readingShade.addColorStop(.77, 'rgba(2,5,13,0)');
  context.fillStyle = readingShade; context.fillRect(0, 0, width, height);
  return layer;
}

function makePlanet(resolution) {
  const layer = surface(resolution);
  const context = layer.getContext('2d');
  if (!context) return layer;
  const pixels = context.createImageData(resolution, resolution);
  const centre = resolution / 2;
  const radius = resolution * .405;
  const sun = { x: .79, y: -.34, z: -.51 };

  for (let y = 0; y < resolution; y++) {
    const ny = (y + .5 - centre) / radius;
    for (let x = 0; x < resolution; x++) {
      const nx = (x + .5 - centre) / radius;
      const radialSquared = nx * nx + ny * ny;
      if (radialSquared > 1.43) continue;
      const offset = (y * resolution + x) * 4;
      const radial = Math.sqrt(radialSquared);

      if (radialSquared > 1) {
        // Rayleigh-like atmospheric scattering, concentrated on the sunlit limb.
        const facingSun = Math.max(0, (nx * sun.x + ny * sun.y) / radial);
        const atmosphere = Math.exp(-(radial - 1) * 43)
          * (.018 + Math.pow(facingSun, 2.6) * .62);
        pixels.data[offset] = 91;
        pixels.data[offset + 1] = 192;
        pixels.data[offset + 2] = 250;
        pixels.data[offset + 3] = Math.min(210, atmosphere * 255);
        continue;
      }

      const nz = Math.sqrt(1 - radialSquared);
      const longitude = Math.atan2(nx, nz);
      const turbulence = cloudNoise(longitude * 3.1 + ny * .9 + 13, ny * 5.5 - 2);
      const band = .5 + .5 * Math.sin(ny * 27 + turbulence * 5.4 + longitude * 1.5);
      const surfaceValue = .47 + turbulence * .28 + band * .25;
      const incident = nx * sun.x + ny * sun.y + nz * sun.z;
      const daylight = Math.pow(Math.max(0, incident), .7);
      const rim = Math.pow(1 - nz, 3.8) * Math.max(0, incident + .25);
      const night = .58 + surfaceValue * .42;
      const light = daylight * surfaceValue;

      // Blue gas layers are visible in the crescent, subdued on the night side.
      pixels.data[offset] = 5 * night + 32 * light + 77 * rim;
      pixels.data[offset + 1] = 12 * night + 96 * light + 162 * rim;
      pixels.data[offset + 2] = 26 * night + 145 * light + 205 * rim;
      pixels.data[offset + 3] = clamp((1 - radial) * radius + .7, 0, 1) * 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return layer;
}

function makeStarGlow() {
  const sprite = surface(64);
  const context = sprite.getContext('2d');
  if (!context) return sprite;
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, 'rgba(214,245,255,.94)');
  glow.addColorStop(.06, 'rgba(175,230,255,.78)');
  glow.addColorStop(.2, 'rgba(91,174,255,.22)');
  glow.addColorStop(1, 'rgba(67,118,251,0)');
  context.fillStyle = glow; context.fillRect(0, 0, 64, 64);
  return sprite;
}

/**
 * @param {HTMLCanvasElement} canvas Full-viewport, aria-hidden background canvas.
 * @returns {{setPaused(value: boolean): void, destroy(): void}}
 */
export function createOrbitSky(canvas) {
  if (!canvas) return { setPaused() {}, destroy() {} };
  let context;
  try { context = canvas.getContext('2d', { alpha: false }); } catch { /* CSS fallback below. */ }
  if (!context) {
    const previousBackground = canvas.style.background;
    canvas.style.background = 'radial-gradient(ellipse at 79% 24%, #17324f 0%, #0a152b 28%, #050916 70%)';
    return {
      setPaused() {},
      destroy() { canvas.style.background = previousBackground; },
    };
  }

  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const finePointer = typeof matchMedia === 'function' ? matchMedia('(pointer: fine)') : null;
  let width = 1, height = 1, ratio = 1, mobile = false;
  let background = null, planet = null, starGlow = null, stars = [];
  let planetResolution = 0;
  // Keep an explicit parent pause separate from the system preference so that
  // changing reduced motion back to normal can resume an otherwise active sky.
  let paused = false, destroyed = false;
  let animationFrame = 0, resizeFrame = 0, lastFrame = 0, lastTick = 0, time = 0;
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  const originalAriaHidden = canvas.getAttribute('aria-hidden');
  canvas.setAttribute('aria-hidden', 'true');

  function buildStars() {
    const random = randomSequence(0x5a17c9);
    const count = mobile ? 78 : clamp(Math.round(width * height / 5600), 140, 310);
    stars = Array.from({ length: count }, (_, index) => {
      const x = random(), y = random(), depth = .25 + random() * .75;
      return {
        x, y, depth,
        size: .34 + random() * (mobile ? .75 : 1.0),
        alpha: (.18 + random() * .55) * (x < .42 ? .55 : 1),
        phase: random() * Math.PI * 2,
        glow: index % (mobile ? 26 : 35) === 0,
      };
    });
  }

  function rebuild() {
    if (destroyed) return;
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(bounds.width || innerWidth || 1));
    const nextHeight = Math.max(1, Math.round(bounds.height || innerHeight || 1));
    const nextMobile = nextWidth <= 700;
    const pixelBudget = nextMobile ? 1100000 : 2700000;
    const nextRatio = Math.min(devicePixelRatio || 1, nextMobile ? 1.25 : 1.5,
      Math.sqrt(pixelBudget / (nextWidth * nextHeight)));
    const changed = width !== nextWidth || height !== nextHeight || ratio !== nextRatio;
    width = nextWidth; height = nextHeight; ratio = nextRatio; mobile = nextMobile;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (changed || !background) {
      if (background) { background.width = 1; background.height = 1; }
      background = makeBackground(width, height, ratio, mobile);
      buildStars();
    }
    const desiredResolution = mobile ? 420 : 680;
    if (!planet || planetResolution !== desiredResolution) {
      if (planet) { planet.width = 1; planet.height = 1; }
      planet = makePlanet(desiredResolution);
      planetResolution = desiredResolution;
    }
    if (!starGlow) starGlow = makeStarGlow();
    draw();
  }

  function draw() {
    if (destroyed || !background || !planet) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.drawImage(background, 0, 0, width, height);

    for (const star of stars) {
      const drift = time * .16 * star.depth;
      const x = ((star.x * width + drift) % (width + 12)) - 6 - pointer.x * star.depth * 7;
      const y = star.y * height - pointer.y * star.depth * 5;
      const brightness = star.alpha * (.86 + .14 * Math.sin(star.phase + time * .3));
      context.globalAlpha = brightness;
      if (star.glow) {
        const size = mobile ? 15 : 22;
        context.drawImage(starGlow, x - size / 2, y - size / 2, size, size);
      } else {
        context.fillStyle = star.depth > .66 ? '#c9e7ff' : '#7198cd';
        context.fillRect(x, y, star.size, star.size);
      }
    }
    context.globalAlpha = 1;

    // A large off-centre world, gently isolated from the desktop's reading area.
    const radius = mobile ? Math.min(width * .39, height * .29)
      : Math.min(width * .226, height * .42);
    const diameter = radius * 2 / .81;
    const centreX = width * (mobile ? .62 : .77) - pointer.x * (mobile ? 0 : 11);
    const centreY = height * (mobile ? .22 : .27) - pointer.y * (mobile ? 0 : 8)
      + Math.sin(time * .075) * (mobile ? 1 : 3);
    context.save();
    context.translate(centreX, centreY);
    context.rotate(-.12 + Math.sin(time * .025) * .008);
    context.drawImage(planet, -diameter / 2, -diameter / 2, diameter, diameter);
    context.restore();

    // A far, barely visible planetary horizon anchors the bottom-right edge.
    context.save();
    const horizonX = width * .91, horizonY = height * 2.28;
    const horizonRadius = height * 1.44;
    const horizon = context.createRadialGradient(horizonX, horizonY, horizonRadius * .965,
      horizonX, horizonY, horizonRadius * 1.02);
    horizon.addColorStop(0, 'rgba(4,8,20,0)');
    horizon.addColorStop(.52, 'rgba(42,91,169,.10)');
    horizon.addColorStop(.65, 'rgba(64,143,211,.065)');
    horizon.addColorStop(1, 'rgba(5,9,22,0)');
    context.fillStyle = horizon;
    context.fillRect(0, height * .65, width, height * .35);
    context.restore();
  }

  function active() {
    return !destroyed && !paused && !media?.matches && !document.hidden;
  }

  function tick(now) {
    animationFrame = 0;
    if (!active()) return;
    const interval = 1000 / (mobile ? 24 : 30);
    if (now - lastFrame >= interval) {
      time += Math.min((now - lastTick) / 1000, .1);
      lastTick = now;
      lastFrame = now;
      pointer.x += (pointer.targetX - pointer.x) * .045;
      pointer.y += (pointer.targetY - pointer.y) * .045;
      draw();
    }
    animationFrame = requestAnimationFrame(tick);
  }

  function refresh() {
    if (active()) {
      if (!animationFrame) {
        lastTick = performance.now();
        animationFrame = requestAnimationFrame(tick);
      }
    } else {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (!destroyed && !document.hidden) draw();
    }
  }

  function scheduleResize() {
    if (destroyed || resizeFrame) return;
    // Separate from animation: a paused wallpaper still redraws on layout changes.
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      rebuild();
    });
  }

  function onPointer(event) {
    if (paused || media?.matches || mobile || finePointer?.matches === false
      || event.pointerType === 'touch') return;
    pointer.targetX = clamp(event.clientX / width * 2 - 1, -1, 1);
    pointer.targetY = clamp(event.clientY / height * 2 - 1, -1, 1);
  }
  function resetPointer() { pointer.targetX = 0; pointer.targetY = 0; }
  function onMotionChange() { resetPointer(); refresh(); }
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleResize) : null;
  resizeObserver?.observe(canvas);
  window.addEventListener('resize', scheduleResize, { passive: true });
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('blur', resetPointer, { passive: true });
  document.addEventListener('visibilitychange', refresh);
  media?.addEventListener?.('change', onMotionChange);

  // Draw synchronously before animation begins. Canvas2D retains this first frame
  // even when the parent immediately calls setPaused(true).
  rebuild();
  refresh();

  return {
    setPaused(value) {
      paused = Boolean(value);
      if (paused) resetPointer();
      refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleResize);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('blur', resetPointer);
      document.removeEventListener('visibilitychange', refresh);
      media?.removeEventListener?.('change', onMotionChange);
      for (const layer of [background, planet, starGlow]) if (layer) { layer.width = 1; layer.height = 1; }
      background = null; planet = null; starGlow = null; stars = [];
      if (originalAriaHidden === null) canvas.removeAttribute('aria-hidden');
      else canvas.setAttribute('aria-hidden', originalAriaHidden);
    },
  };
}
