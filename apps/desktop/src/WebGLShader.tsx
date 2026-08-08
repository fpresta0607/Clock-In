import { useEffect, useRef } from "react";
import * as THREE from "three";

interface WebGLShaderProps {
  /** When true, sizes to parent element instead of viewport */
  contained?: boolean;
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
 */
export function WebGLShader({ contained = false, className }: WebGLShaderProps) {
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

      // ── Hash noise ──────────────────────────────────────────────────────
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float smoothNoise(float x) {
        float i = floor(x);
        float f = fract(x);
        float u = f * f * (3.0 - 2.0 * f);
        return mix(hash(i), hash(i + 1.0), u);
      }

      void main() {
        vec2 p = (gl_FragCoord.xy * 2.0 - resolution) / min(resolution.x, resolution.y);
        float d = length(p) * distortion;

        float rx = p.x * (1.0 + d);
        float gx = p.x;
        float bx = p.x * (1.0 - d);

        // ── Convert mouse → shader coordinate space ─────────────────────
        // gl_FragCoord.y = 0 at bottom; canvas mouse.y = 0 at top
        float aspect   = resolution.x / min(resolution.x, resolution.y);
        float mxShader = (mouse.x * 2.0 - 1.0) * aspect;
        float myShader = ((1.0 - mouse.y) * 2.0 - 1.0) * (resolution.y / min(resolution.x, resolution.y));

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
        float xProx   = smoothstep(0.5, 0.0, abs(p.x - mxShader));
        float electric = cursorOnWave * xProx * onCanvas;

        // ── Electric jitter (only when cursor is on a wave) ──────────────
        float jitterCoarse = (smoothNoise(p.x * 30.0  + time * 15.0) * 2.0 - 1.0);
        float jitterFine   = (smoothNoise(p.x * 120.0 + time * 40.0) * 2.0 - 1.0);
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

        gl_FragColor = vec4(color, 1.0);
      }
    `;

    // ── Helpers ───────────────────────────────────────────────────────────
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const getDimensions = () => {
      if (contained && canvas.parentElement) {
        const rect = canvas.parentElement.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }
      return { width: window.innerWidth, height: window.innerHeight };
    };

    // ── Scene init ────────────────────────────────────────────────────────
    const initScene = () => {
      refs.scene = new THREE.Scene();
      refs.renderer = new THREE.WebGLRenderer({ canvas });
      refs.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      refs.renderer.setClearColor(new THREE.Color(0x000000));

      refs.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, -1);

      const { width, height } = getDimensions();
      const dpr = refs.renderer.getPixelRatio();
      refs.uniforms = {
        resolution: { value: [width * dpr, height * dpr] },
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
    window.addEventListener("resize", handleResize);

    return () => {
      // Flag the loop as dead before cancelling — prevents any in-flight tick from re-queuing
      destroyed = true;
      if (refs.animationId) cancelAnimationFrame(refs.animationId);
      refs.animationId = null;

      window.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseenter", handleMouseEnter);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("resize", handleResize);
      if (refs.mesh) {
        refs.scene?.remove(refs.mesh);
        refs.mesh.geometry.dispose();
        if (refs.mesh.material instanceof THREE.Material) refs.mesh.material.dispose();
        refs.mesh = null;
      }
      refs.renderer?.dispose();
      // Force WebGL context loss so the browser reclaims the slot immediately
      const ext =
        canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context") ??
        canvas.getContext("webgl")?.getExtension("WEBGL_lose_context");
      ext?.loseContext();
      refs.renderer = null;
      refs.scene = null;
      refs.uniforms = null;
    };
  }, [contained]);

  return <canvas ref={canvasRef} className={className ?? "shader-bg"} />;
}
