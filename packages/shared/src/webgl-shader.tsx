import { useEffect, useRef } from "react";
import * as THREE from "three";

interface WebGLShaderProps {
  className?: string;
}

type WaveUniforms = {
  resolution: THREE.IUniform;
  time: THREE.IUniform;
  xScale: THREE.IUniform;
  yScale: THREE.IUniform;
  distortion: THREE.IUniform;
  mouse: THREE.IUniform;
  influence: THREE.IUniform;
  onCanvas: THREE.IUniform;
};

/**
 * Fullscreen chromatic sine-wave shader, ported from the SIQstack homepage
 * hero (web-gl-shader.tsx). Green/blue/purple waves with cursor-reactive
 * electric jitter; plain three.js, no react-three-fiber.
 *
 * It lives here because it shipped for months as byte-identical hand-synced
 * copies in `apps/desktop/src` and `apps/web/src`, and a background fix landed
 * in one app and not the other twice. React and three are this package's only
 * optional peers, reached through the `./webgl-shader` entry alone, so the API
 * - which imports the contracts entry and nothing else - never pulls either.
 * `.shader-bg`, the rule that gives the canvas its box, travels with it in
 * `styles/brand.css`.
 */
export function WebGLShader({ className }: WebGLShaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const sceneRef = useRef<{
    scene: THREE.Scene | null;
    camera: THREE.OrthographicCamera | null;
    renderer: THREE.WebGLRenderer | null;
    mesh: THREE.Mesh | null;
    uniforms: WaveUniforms | null;
    animationId: number | null;
  }>({
    scene: null,
    camera: null,
    renderer: null,
    mesh: null,
    uniforms: null,
    animationId: null,
  });

  const mouseRef = useRef({
    x: 0.5,
    y: 0.5,
    lastX: 0.5,
    lastY: 0.5,
    lastTime: 0,
    influence: 0, // 0–1, boosted by speed, decays over time
    onCanvas: 0, // 1 when cursor is over canvas, 0 when off — lerped
  });

  useEffect(() => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const { current: refs } = sceneRef;

    // ── Base constants ────────────────────────────────────────────────────
    const BASE_TIME_STEP = 0.01;
    const BASE_Y_SCALE = 0.4;
    const BASE_DISTORTION = 0.45;

    let timeStep = BASE_TIME_STEP;

    // ── Vertex shader ─────────────────────────────────────────────────────
    const vertexShader = `
      attribute vec3 position;
      void main() {
        gl_Position = vec4(position, 1.0);
      }
    `;

    // ── Fragment shader ───────────────────────────────────────────────────
    const fragmentShader = `
      precision highp float;

      uniform vec2  resolution;
      uniform float time;
      uniform float xScale;
      uniform float yScale;
      uniform float distortion;

      // cursor uniforms
      uniform vec2  mouse;       // 0–1 normalized (x left→right, y top→bottom)
      uniform float influence;   // 0–1 cursor-activity level
      uniform float onCanvas;    // 0–1 whether cursor is over the hero

      // The wave was drawn against a landscape hero, where the canvas is
      // wider than it is tall. Normalising both axes by min(resolution.x,
      // resolution.y) - the usual fullscreen-shader idiom - picks the height
      // there, so the sine's period and its amplitude were both a share of the
      // height. SIQshift's window is portrait (520x920 by default, never
      // narrower than 400x600), so that same expression picks the *width*: the
      // period becomes 2*PI*width, under a third of one fits across the
      // window, and every band reads as a straight streak running off both
      // edges instead of a wave behind the card. Normalising each axis by its
      // own extent makes the wave's shape a property of the drawing rather
      // than of the window - the same number of periods across the canvas and
      // the same share of its height at every aspect - and WAVE_ASPECT gives
      // back the proportions it was drawn at, so a 16:10 window renders
      // exactly what it rendered before.
      const float WAVE_ASPECT = 1.6;

      // ── Hash noise ──────────────────────────────────────────────────────
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float smoothNoise(float x) {
        float i = floor(x);
        float f = fract(x);
        float u = f * f * (3.0 - 2.0 * f);
        return mix(hash(i), hash(i + 1.0), u);
      }

      void main() {
        // p spans -1..1 across the canvas on each axis; px is that same
        // horizontal position in the wave's own proportions.
        vec2 p  = (gl_FragCoord.xy * 2.0 - resolution) / resolution;
        float px = p.x * WAVE_ASPECT;
        float d = length(vec2(px, p.y)) * distortion;

        float rx = px * (1.0 + d);
        float gx = px;
        float bx = px * (1.0 - d);

        // ── Convert mouse → shader coordinate space ─────────────────────
        // gl_FragCoord.y = 0 at bottom; canvas mouse.y = 0 at top
        float mxShader = (mouse.x * 2.0 - 1.0) * WAVE_ASPECT;
        float myShader = (1.0 - mouse.y) * 2.0 - 1.0;

        // ── Where are the waves at cursor X? ────────────────────────────
        // Evaluate sine at cursor's X to find each wave's Y there
        float cursorD  = length(vec2(mxShader, myShader)) * distortion;
        float cRx      = mxShader * (1.0 + cursorD);
        float cGx      = mxShader;
        float cBx      = mxShader * (1.0 - cursorD);
        float wy1      = -sin((cRx + time) * xScale) * yScale;
        float wy2      = -sin((cGx + time) * xScale) * yScale;
        float wy3      = -sin((cBx + time) * xScale) * yScale;

        // Closest distance cursor Y is to any wave at cursor X
        float minWaveDist = min(abs(myShader - wy1), min(abs(myShader - wy2), abs(myShader - wy3)));

        // cursorOnWave: 1 when cursor sits on/near a wave, 0 otherwise
        float cursorOnWave = smoothstep(0.12, 0.0, minWaveDist);

        // Effect spreads from cursor X along the wave path
        float xProx   = smoothstep(0.5, 0.0, abs(px - mxShader));
        float electric = cursorOnWave * xProx * onCanvas;

        // ── Electric jitter (only when cursor is on a wave) ──────────────
        float jitterCoarse = (smoothNoise(px * 30.0  + time * 15.0) * 2.0 - 1.0);
        float jitterFine   = (smoothNoise(px * 120.0 + time * 40.0) * 2.0 - 1.0);
        float jitter    = jitterCoarse * 0.6 + jitterFine * 0.4;
        float jitterAmt = electric * (0.025 + influence * 0.055) * jitter;

        // ── Wave distances (with jitter) ─────────────────────────────────
        float w1 = 0.018 / abs(p.y + sin((rx + time) * xScale) * yScale + jitterAmt);
        float w2 = 0.018 / abs(p.y + sin((gx + time) * xScale) * yScale + jitterAmt);
        float w3 = 0.018 / abs(p.y + sin((bx + time) * xScale) * yScale + jitterAmt);

        // ── Glow boost along the wave where cursor touches ───────────────
        float glow = 1.0 + electric * (2.0 + influence * 4.0);
        w1 *= glow;
        w2 *= glow;
        w3 *= glow;

        // ── Brand colours ─────────────────────────────────────────────────
        vec3 green  = vec3(0.0, 0.898, 0.608);   // #00e59b
        vec3 purple = vec3(0.659, 0.333, 0.969);  // #a855f7
        vec3 blue   = vec3(0.0, 0.549, 1.0);      // #008cff

        vec3 color = w1 * green + w2 * blue + w3 * purple;

        // The wave sums three unbounded 1/distance glows, so every beam core
        // used to clip to flat white. Against a glass panel - which blurs and
        // dims whatever is behind it - a clipped core reads as a hard seam at
        // the panel's edge and as a stray blob under it. Reinhard keeps the
        // curve and the brand colours and only takes the shoulder off.
        gl_FragColor = vec4(color / (color + 1.0), 1.0);
      }
    `;

    // ── Helpers ───────────────────────────────────────────────────────────
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // The canvas' own laid-out box, never `window.innerWidth`: that figure
    // includes the scrollbars the content column takes away, so a buffer sized
    // from it is wider than the box it is painted into and the wave renders
    // squashed. Measuring the element keeps the background's sizing
    // independent of anything the content does.
    const getDimensions = () => {
      const rect = canvas.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };

    // ── Scene init ────────────────────────────────────────────────────────
    const initScene = () => {
      refs.scene = new THREE.Scene();
      refs.renderer = new THREE.WebGLRenderer({ canvas });
      refs.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      refs.renderer.setClearColor(new THREE.Color(0x000000));

      refs.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

      refs.uniforms = {
        // `handleResize` below sets the real one. A canvas that has not been
        // laid out yet measures zero, and the shader divides by each axis, so
        // the placeholder is 1x1 rather than 0x0.
        resolution: { value: [1, 1] },
        time: { value: 0.0 },
        xScale: { value: 1.0 },
        yScale: { value: BASE_Y_SCALE },
        distortion: { value: BASE_DISTORTION },
        mouse: { value: [0.5, 0.5] },
        influence: { value: 0.0 },
        onCanvas: { value: 0.0 },
      };

      const position = [
        -1.0, -1.0, 0.0, 1.0, -1.0, 0.0, -1.0, 1.0, 0.0,
        1.0, -1.0, 0.0, -1.0, 1.0, 0.0, 1.0, 1.0, 0.0,
      ];

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(position), 3));

      const material = new THREE.RawShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: refs.uniforms,
        side: THREE.DoubleSide,
      });

      refs.mesh = new THREE.Mesh(geometry, material);
      refs.scene.add(refs.mesh);

      handleResize();
    };

    // ── Animation loop ────────────────────────────────────────────────────
    let destroyed = false;

    const animate = () => {
      // Stop loop if cleanup has already run — prevents zombie RAF loops
      if (destroyed) return;

      const m = mouseRef.current;

      // influence always decays to 0 — no speed boost (waves stay constant speed)
      // kept in shader only for electric jitter amplitude when cursor is on a wave
      m.influence = lerp(m.influence, 0, 0.035);
      // Lerp onCanvas toward target
      m.onCanvas = lerp(m.onCanvas, m.onCanvas > 0.5 ? 1.0 : 0.0, 0.08);

      // Fixed time step — waves never speed up with cursor movement
      timeStep = BASE_TIME_STEP;

      if (refs.uniforms) {
        refs.uniforms.time.value += timeStep;
        refs.uniforms.mouse.value = [m.x, m.y];
        refs.uniforms.influence.value = m.influence;
        refs.uniforms.onCanvas.value = m.onCanvas;

        // yScale and distortion locked to base — no cursor-speed amplitude changes
        refs.uniforms.yScale.value = BASE_Y_SCALE;
        refs.uniforms.distortion.value = BASE_DISTORTION;
      }

      if (refs.renderer && refs.scene && refs.camera) {
        refs.renderer.render(refs.scene, refs.camera);
      }
      refs.animationId = requestAnimationFrame(animate);
    };

    // ── Mouse / touch handlers ────────────────────────────────────────────
    const handleMouseMove = (e: MouseEvent) => {
      const m = mouseRef.current;
      const now = performance.now();
      const dt = Math.max(now - m.lastTime, 1);

      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      const dx = x - m.lastX;
      const dy = y - m.lastY;
      const speed = Math.sqrt(dx * dx + dy * dy) / (dt / 1000);

      m.x = x;
      m.y = y;
      m.lastX = x;
      m.lastY = y;
      m.lastTime = now;
      m.onCanvas = 1.0;

      // No speed boost — influence stays at 0 (waves constant speed)
      void speed;
    };

    const handleMouseEnter = () => {
      mouseRef.current.onCanvas = 1.0;
    };
    const handleMouseLeave = () => {
      mouseRef.current.onCanvas = 0.0;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const t = e.touches.item(0);
      if (!t) return;
      handleMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    };

    const handleResize = () => {
      if (!refs.renderer || !refs.uniforms) return;
      const { width, height } = getDimensions();
      // A hidden or not-yet-laid-out canvas measures zero, and a zero
      // resolution divides by zero in the shader. Keep the last good size.
      if (width === 0 || height === 0) return;
      // Re-read the ratio on every pass: a buffer left at the old ratio is
      // the one thing that does make the wave look resampled. Getting here
      // on a ratio-only change is the observer registration's job below.
      refs.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      refs.renderer.setSize(width, height, false);
      const dpr = refs.renderer.getPixelRatio();
      refs.uniforms.resolution.value = [width * dpr, height * dpr];
    };

    // ── Bootstrap ─────────────────────────────────────────────────────────
    try {
      initScene();
      animate();
    } catch {
      // No WebGL support (or jsdom): the plain dark background still works.
      return;
    }

    window.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseenter", handleMouseEnter);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    // Observing the canvas catches every reason its box changed - the window,
    // a scrollbar appearing, a container resizing - where a window `resize`
    // listener only catches the first. device-pixel-content-box also fires
    // on a devicePixelRatio-only change (the window dragged to a display
    // scaled differently), which leaves the CSS box alone; browsers without
    // it throw on observe and fall back to the default content-box, where a
    // stale ratio lasts until the next real box change.
    const sizeObserver = new ResizeObserver(handleResize);
    try {
      sizeObserver.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      sizeObserver.observe(canvas);
    }

    return () => {
      // Flag the loop as dead before cancelling — prevents any in-flight tick from re-queuing
      destroyed = true;
      if (refs.animationId) cancelAnimationFrame(refs.animationId);
      refs.animationId = null;

      window.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseenter", handleMouseEnter);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("touchmove", handleTouchMove);
      sizeObserver.disconnect();
      if (refs.mesh) {
        refs.scene?.remove(refs.mesh);
        refs.mesh.geometry.dispose();
        if (refs.mesh.material instanceof THREE.Material) refs.mesh.material.dispose();
        refs.mesh = null;
      }
      // dispose() releases the renderer's GL resources; the canvas keeps its
      // context. Do NOT force WEBGL_lose_context here: React StrictMode mounts,
      // cleans up, and remounts on the same canvas in dev, and a lost context
      // never comes back — the remounted renderer would paint a blank canvas
      // (white in WebView2). Context slots are reclaimed with the canvas element.
      refs.renderer?.dispose();
      refs.renderer = null;
      refs.scene = null;
      refs.uniforms = null;
    };
  }, []);

  return <canvas ref={canvasRef} className={className ?? "shader-bg"} />;
}
