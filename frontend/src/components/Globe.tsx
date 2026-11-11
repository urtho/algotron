import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { NodeState } from '../../../shared/types.ts';
import land from '../assets/land-110m.json';
import { landDots } from '../landDots.ts';
import { algoLogo } from './algologo.tsx';

interface Props {
  nodes: NodeState[];
  /** Newest block and the node that showed it first: drawn as a ring and arcs to other nodes */
  pulse?: { round: number; id: string };
  /** Wall mode: the globe turns to face the node that showed each block first */
  follow?: boolean;
  /** Delay drawn as the darkest step of the wavefront ramp, ms */
  waveMax: number;
  /** Playback slowdown of the wavefront (1 = real time) */
  waveSlow: number;
  /** Only nodes timed by avmonitor take part in the wave */
  timedOnly: boolean;
}

/**
 * Bloom: `?fx=1` forces it on, `?fx=0` off. By default it is on and switches
 * itself off when the display cannot hold about 25 frames per second with it.
 */
const FX = new URLSearchParams(location.search).get('fx');
const SLOW_FRAME_MS = 40;

interface Fx {
  obj: THREE.Mesh | THREE.Line;
  born: number;
  life: number;
  grow: number;
  opacity: number;
}

// GeoJSON geometry types we care about
interface GeoPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}
interface GeoMultiPolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}
type GeoGeometry = GeoPolygon | GeoMultiPolygon | { type: string };
interface GeoFeature {
  geometry: GeoGeometry;
}

// Convert geographic coordinates to 3-D position on a unit sphere
function latLngToVec3(lat: number, lng: number, r = 1): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

const STATUS_COLORS: Record<NodeState['status'], number> = {
  synced: 0x00ff88,
  lagging: 0xffff00,
  behind: 0xff8800,
  offline: 0xff2222,
  unknown: 0x336655,
};

const ARCHIVER_COLOR = 0x00aaff;
const ARC_POINTS = 48;
/** How long a node stays lit when the wavefront reaches it */
const WAVE_HOLD_MS = 900;

export function Globe({ nodes, pulse, follow, waveMax, waveSlow, timedOnly }: Props) {
  const timedRef = useRef(timedOnly);
  timedRef.current = timedOnly;
  const waveCfg = useRef({ max: waveMax, slow: waveSlow });
  waveCfg.current = { max: waveMax, slow: waveSlow };
  const followRef = useRef(false);
  followRef.current = !!follow;
  /** Rotation that brings the newest block's first node to the front */
  const aimRef = useRef<{ x: number; y: number } | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const dotsGroupRef = useRef<THREE.Group | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef = useRef<number>(0);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const nodeMapRef = useRef<Map<THREE.Object3D, NodeState>>(new Map());
  const tooltipRef = useRef<HTMLDivElement>(null);
  const fxGroupRef = useRef<THREE.Group | null>(null);
  const fxRef = useRef<Fx[]>([]);
  /** Wavefront: when the newest block was first seen (page clock) and each node's usual delay */
  const waveRef = useRef<{ born: number; delay: Map<string, number> }>({ born: 0, delay: new Map() });
  const nodesRef = useRef<NodeState[]>(nodes);
  nodesRef.current = nodes;

  // ── Initial Three.js setup (runs once) ──────────────────────────────────────
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const w = container.clientWidth;
    const h = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x00060f); // the bloom pass needs an opaque frame

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.z = 3.36;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // ── Globe sphere ──────────────────────────────────────────────────────────
    const globeGroup = new THREE.Group();
    globeGroup.rotation.x = 30 * (Math.PI / 180); // tilt north pole toward viewer
    scene.add(globeGroup);

    const sphereGeo = new THREE.SphereGeometry(1, 64, 64);
    const sphereMat = new THREE.MeshPhongMaterial({
      color: 0x001a33,
      emissive: 0x000d1a,
      specular: 0x003366,
      shininess: 10,
      transparent: true,
      opacity: 0.92,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    globeGroup.add(sphere);

    // ── Atmosphere rim: brightest where the sphere turns away from the camera ───
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(1.09, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader:
          'varying vec3 n; void main(){ n = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'varying vec3 n; void main(){ float k = pow(0.62 - dot(n, vec3(0.0, 0.0, 1.0)), 3.0); gl_FragColor = vec4(0.0, 0.62, 1.0, 1.0) * clamp(k, 0.0, 1.0) * 0.9; }',
      }),
    );
    scene.add(rim);

    // ── Atmosphere glow ───────────────────────────────────────────────────────
    // const atmoGeo = new THREE.SphereGeometry(1.05, 32, 32);
    // const atmoMat = new THREE.MeshPhongMaterial({
    //   color: 0x0044aa,
    //   transparent: true,
    //   opacity: 0.26,
    //   side: THREE.BackSide,
    // });
    // globeGroup.add(new THREE.Mesh(atmoGeo, atmoMat));

    // ── Latitude / longitude grid ─────────────────────────────────────────────
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x004422,
      transparent: true,
      opacity: 0.35,
    });

    function addLine(points: THREE.Vector3[]) {
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      globeGroup.add(new THREE.Line(geo, gridMat));
    }

    // Parallels every 30°
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts: THREE.Vector3[] = [];
      for (let lng = 0; lng <= 360; lng += 3) {
        pts.push(latLngToVec3(lat, lng - 180, 1.001));
      }
      addLine(pts);
    }

    // Meridians every 30°
    for (let lng = 0; lng < 360; lng += 30) {
      const pts: THREE.Vector3[] = [];
      for (let lat = -90; lat <= 90; lat += 3) {
        pts.push(latLngToVec3(lat, lng - 180, 1.001));
      }
      addLine(pts);
    }

    // Equator highlight
    const eqMat = new THREE.LineBasicMaterial({ color: 0x006633, transparent: true, opacity: 0.6 });
    {
      const pts: THREE.Vector3[] = [];
      for (let lng = 0; lng <= 360; lng += 2) pts.push(latLngToVec3(0, lng - 180, 1.002));
      globeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), eqMat));
    }

    // ── Scanning meridian ray ─────────────────────────────────────────────────
    const TRAIL_COUNT = 10;
    const TRAIL_SPREAD_DEG = 12;
    const scanGroup = new THREE.Group();
    globeGroup.add(scanGroup);

    for (let i = 0; i < TRAIL_COUNT; i++) {
      const t = i / (TRAIL_COUNT - 1);
      const lngOffset = -t * TRAIL_SPREAD_DEG;
      const opacity = (1 - t) ** 1.4 * 0.82;
      if (opacity < 0.01) continue;

      const pts: THREE.Vector3[] = [];
      for (let lat = -87; lat <= 87; lat += 3) {
        pts.push(latLngToVec3(lat, lngOffset, 1.004));
      }

      scanGroup.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity }),
        ),
      );
    }

    // ── Node dots group ───────────────────────────────────────────────────────
    const dotsGroup = new THREE.Group();
    globeGroup.add(dotsGroup);
    dotsGroupRef.current = dotsGroup;

    const fxGroup = new THREE.Group();
    globeGroup.add(fxGroup);
    fxGroupRef.current = fxGroup;

    // ── Lights ────────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x112244, 1.5);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0x3366ff, 1.2);
    sun.position.set(5, 3, 5);
    scene.add(sun);

    // ── HUD: Algorand logo pinned to lower-left, independent of globe ─────────
    // Logo geometry spans ~3.58 Three.js units; scale to ~80 screen pixels.
    const LOGO_SCALE = 22;
    const LOGO_HALF = (3.58 * LOGO_SCALE) / 2; // ≈ 39 px
    const LOGO_MARGIN = 16;

    const hudScene = new THREE.Scene();
    hudScene.add(new THREE.AmbientLight(0x223344, 2.0));
    const hudLight = new THREE.DirectionalLight(0x3399ff, 2.5);
    hudLight.position.set(3, 4, 5);
    hudScene.add(hudLight);

    const hudCam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 200);
    hudCam.position.z = 100;

    const logoGroup = algoLogo();
    logoGroup.scale.setScalar(LOGO_SCALE);
    logoGroup.rotation.x = 0.0;
    logoGroup.position.set(-w / 2 + LOGO_MARGIN + LOGO_HALF, -h / 2 + LOGO_MARGIN + LOGO_HALF, 0);
    hudScene.add(logoGroup);

    // ── Continent contours ────────────────────────────────────────────────────
    const landMat = new THREE.LineBasicMaterial({
      color: 0x00662e,
      transparent: true,
      opacity: 0.35,
    });
    {
      const geojson = land as unknown as { features: GeoFeature[] };
      const contourGroup = new THREE.Group();

      function addRing(coords: number[][]) {
        if (coords.length < 2) return;
        const pts = coords.map(([lng, lat]) => latLngToVec3(lat!, lng!, 1.002));
        contourGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), landMat));
      }

      for (const f of geojson.features) {
        const g = f.geometry;
        if (g.type === 'Polygon') {
          for (const ring of (g as GeoPolygon).coordinates) addRing(ring);
        } else if (g.type === 'MultiPolygon') {
          for (const poly of (g as GeoMultiPolygon).coordinates) for (const ring of poly) addRing(ring);
        }
      }

      globeGroup.add(contourGroup);

      // ── Land as a dot matrix ────────────────────────────────────────────────
      const dots = landDots(geojson.features, 1.5);
      const pos = new Float32Array(dots.length * 3);
      dots.forEach(([lat, lng], i) => {
        const v = latLngToVec3(lat, lng, 1.003);
        pos.set([v.x, v.y, v.z], i * 3);
      });
      const dotGeo = new THREE.BufferGeometry();
      dotGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      globeGroup.add(
        new THREE.Points(
          dotGeo,
          new THREE.PointsMaterial({
            color: 0x19c477,
            size: 0.011,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.85,
          }),
        ),
      );
    }

    // ── Bloom ─────────────────────────────────────────────────────────────────
    let bloomOn = FX !== '0' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.5, 0.3));
    composer.addPass(new OutputPass());
    let slowFrames = 0;

    // ── Drag-to-rotate ────────────────────────────────────────────────────────
    let isDragging = false;
    let lastPointerX = 0;
    let lastPointerY = 0;

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      container.setPointerCapture(e.pointerId);
      container.style.cursor = 'grabbing';
      if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (isDragging) {
        const dx = e.clientX - lastPointerX;
        const dy = e.clientY - lastPointerY;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        globeGroup.rotation.y += dx * 0.005;
        globeGroup.rotation.x += dy * 0.005;
        globeGroup.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, globeGroup.rotation.x));
        return;
      }

      // Raycast to find hovered node dot
      const rect = container.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        ((e.clientY - rect.top) / rect.height) * -2 + 1,
      );
      raycasterRef.current.setFromCamera(mouse, camera);
      const hits = raycasterRef.current.intersectObjects(
        dotsGroupRef.current ? dotsGroupRef.current.children : [],
        false,
      );
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (hits.length > 0) {
        const node = nodeMapRef.current.get(hits[0]!.object);
        if (node) {
          const live = nodesRef.current.find((n) => n.id === node.id) ?? node;
          tooltip.textContent = [
            live.label,
            live.status + (live.err ? ` (${live.err})` : ''),
            live.city,
            live.net,
            live.rtt ? `${Math.round(live.rtt)} ms` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          tooltip.style.left = `${e.clientX - rect.left + 14}px`;
          tooltip.style.top = `${e.clientY - rect.top - 10}px`;
          tooltip.style.display = 'block';
        }
      } else {
        tooltip.style.display = 'none';
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      isDragging = false;
      container.releasePointerCapture(e.pointerId);
      container.style.cursor = 'grab';
    };

    const onPointerLeave = () => {
      if (tooltipRef.current) tooltipRef.current.style.display = 'none';
    };

    container.style.cursor = 'grab';
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
    container.addEventListener('pointerleave', onPointerLeave);

    // ── Slow rotation & scan ──────────────────────────────────────────────────
    let lastTime = performance.now();
    let scanAngle = 0;
    const _tempColor = new THREE.Color();
    const _whiteColor = new THREE.Color(0xffffff);
    const _waveColor = new THREE.Color();

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const aim = aimRef.current;
      if (isDragging) {
        aimRef.current = null;
      } else if (followRef.current && aim) {
        // ease toward the first node of the newest block, the short way round
        const TAU = Math.PI * 2;
        const dy = ((((aim.y - globeGroup.rotation.y) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
        const ease = 1 - Math.exp(-dt * 1.6);
        globeGroup.rotation.y += dy * ease;
        globeGroup.rotation.x += (aim.x - globeGroup.rotation.x) * ease;
      } else {
        globeGroup.rotation.y += 0.04 * dt; // ~2.4°/s
      }

      // bloom costs several extra passes: drop it when frames stay slow
      if (bloomOn && FX !== '1') {
        slowFrames = dt * 1000 > SLOW_FRAME_MS ? slowFrames + 1 : Math.max(0, slowFrames - 2);
        if (slowFrames > 90) {
          bloomOn = false;
          console.info('[GLOBE] bloom switched off: this display is too slow for it (force with ?fx=1)');
        }
      }
      logoGroup.rotation.y -= 0.8 * dt; // ~1 revolution per 7.9 s
      scanAngle += ((2 * Math.PI) / 2.8) * dt; // one full revolution per 2.8 s
      scanGroup.rotation.y = scanAngle;

      // ── Scanner glow: brighten & enlarge nodes under the leading meridian ───
      for (const [dot, node] of nodeMapRef.current) {
        // Node's angle in globeGroup x-z plane: lng=0 → angle 0, lng=90 → -π/2
        const nodeAngle = -node.lng * (Math.PI / 180);
        let diff = (((-scanAngle - nodeAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI; // normalise to (-π, π]

        const intensity = Math.max(0, 1 - Math.abs(diff + 0.18) / 0.22); // peak 0.18 rad behind leading edge
        const baseHex = node.type === 'archiver' ? ARCHIVER_COLOR : STATUS_COLORS[node.status];
        const mat = (dot as THREE.Mesh).material as THREE.MeshBasicMaterial;
        _tempColor.set(baseHex);
        mat.color.lerpColors(_tempColor, _whiteColor, intensity * 0.75);
        let scale = 1 + intensity * 0.5;

        // ── Wavefront: the node lights up at its usual delay after the block was first seen,
        //    in one hue that runs from light (early) to dark (late)
        const delay = waveRef.current.delay.get(node.id);
        if (delay !== undefined) {
          const since = now - waveRef.current.born - delay * waveCfg.current.slow;
          if (since >= 0 && since < WAVE_HOLD_MS) {
            const k = 1 - since / WAVE_HOLD_MS;
            _waveColor.setHSL(192 / 360, 0.9, 0.78 - Math.min(1, delay / waveCfg.current.max) * 0.46);
            mat.color.lerp(_waveColor, Math.min(1, k * 1.6));
            scale = Math.max(scale, 1 + k * 1.6);
          }
        }
        (dot as THREE.Mesh).scale.setScalar(scale);
      }

      // ── Block pulses: rings and arcs fade out and are removed ────────────────
      const fx = fxRef.current;
      for (let i = fx.length - 1; i >= 0; i--) {
        const f = fx[i]!;
        const t = (now - f.born) / f.life;
        const mat = f.obj.material as THREE.Material;
        if (t >= 1) {
          fxGroup.remove(f.obj);
          f.obj.geometry.dispose();
          mat.dispose();
          fx.splice(i, 1);
          continue;
        }
        if (t < 0) continue;
        mat.opacity = f.opacity * (1 - t) ** 1.5;
        if (f.grow) f.obj.scale.setScalar(1 + f.grow * t);
        else (f.obj as THREE.Line).geometry.setDrawRange(0, Math.ceil(ARC_POINTS * Math.min(1, t * 2.2)));
      }

      if (bloomOn) composer.render();
      else renderer.render(scene, camera);

      // Render HUD (logo) on top without clearing the colour buffer
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(hudScene, hudCam);
      renderer.autoClear = true;
    };
    animate();

    // ── Resize observer ───────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const nw = container.clientWidth;
      const nh = container.clientHeight;
      renderer.setSize(nw, nh);
      composer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      // Keep HUD camera and logo position in sync with canvas size
      hudCam.left = -nw / 2;
      hudCam.right = nw / 2;
      hudCam.top = nh / 2;
      hudCam.bottom = -nh / 2;
      hudCam.updateProjectionMatrix();
      logoGroup.position.set(-nw / 2 + LOGO_MARGIN + LOGO_HALF, -nh / 2 + LOGO_MARGIN + LOGO_HALF, 0);
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('pointerleave', onPointerLeave);
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      dotsGroupRef.current = null;
      fxGroupRef.current = null;
      fxRef.current = [];
    };
  }, []);

  // Rebuild the meshes only when a node appears, moves or changes status
  const signature = useMemo(() => nodes.map((n) => `${n.id}:${n.status}:${n.lat}`).join('|'), [nodes]);

  // ── New block: ring at the first node, arcs to the nodes that follow ─────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per round
  useEffect(() => {
    const group = fxGroupRef.current;
    if (!group || !pulse || document.hidden) return;
    const all = nodesRef.current;
    const origin = all.find((n) => n.id === pulse.id);
    if (!origin || (origin.lat === 0 && origin.lng === 0)) return;
    const now = performance.now();
    waveRef.current = {
      born: now,
      delay: new Map(
        all
          .filter(
            (n) => n.status === 'synced' && (!timedRef.current || n.soft !== undefined || n.id === origin.id),
          )
          .map((n) => [n.id, n.id === origin.id ? 0 : n.prop || 0]),
      ),
    };
    const from = latLngToVec3(origin.lat, origin.lng, 1.006);
    // rotation.y that puts the node on the camera's meridian, and a tilt toward its latitude
    aimRef.current = {
      y: Math.atan2(-from.x, from.z),
      x: Math.max(-0.9, Math.min(0.9, (origin.lat * Math.PI) / 180)) * 0.85,
    };

    for (const [delay, grow, opacity] of [
      [0, 9, 0.9],
      [180, 16, 0.5],
    ] as const) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.012, 0.016, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.position.copy(from);
      ring.lookAt(from.clone().multiplyScalar(2));
      group.add(ring);
      fxRef.current.push({ obj: ring, born: now + delay, life: 1500, grow, opacity });
    }

    // arcs to the fastest followers, one per location
    const seen = new Set<string>([`${origin.lat},${origin.lng}`]);
    const targets = all
      .filter((n) => n.status === 'synced' && (n.lat !== 0 || n.lng !== 0))
      .sort((a, b) => (a.prop || 9e9) - (b.prop || 9e9))
      .filter((n) => {
        const k = `${n.lat},${n.lng}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 14);
    const a = from.clone().normalize();
    targets.forEach((n, i) => {
      const b = latLngToVec3(n.lat, n.lng, 1).normalize();
      const angle = a.angleTo(b);
      if (angle < 0.02) return;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= ARC_POINTS; k++) {
        const t = k / ARC_POINTS;
        const p = a
          .clone()
          .multiplyScalar(Math.sin((1 - t) * angle))
          .addScaledVector(b, Math.sin(t * angle));
        pts.push(p.normalize().multiplyScalar(1.006 + Math.sin(Math.PI * t) * Math.min(0.3, angle * 0.12)));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.75, depthWrite: false }),
      );
      line.geometry.setDrawRange(0, 0);
      group.add(line);
      fxRef.current.push({ obj: line, born: now + i * 25, life: 1300 + angle * 300, grow: 0, opacity: 0.75 });
    });
  }, [pulse?.round]);

  // ── Sync node dots when `nodes` changes ──────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature stands for the node list
  useEffect(() => {
    const group = dotsGroupRef.current;
    if (!group) return;

    // Clear existing dots
    nodeMapRef.current.clear();
    while (group.children.length) {
      const child = group.children[0] as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
      group.remove(child);
    }

    const archiverDotGeo = new THREE.SphereGeometry(0.018, 8, 8);

    for (const node of nodesRef.current) {
      if (node.lat === 0 && node.lng === 0) continue;

      const colorHex = node.type === 'archiver' ? ARCHIVER_COLOR : STATUS_COLORS[node.status];

      if (node.type === 'relay') {
        // ── Satellite-style relay ────────────────────────────────────────────
        const satRadius =
          node.status === 'synced'
            ? 1.1
            : node.status === 'lagging'
              ? 1.11
              : node.status === 'behind'
                ? 1.12
                : node.status === 'offline'
                  ? 1.13
                  : 1.1;

        const pos = latLngToVec3(node.lat, node.lng, satRadius);
        const surfacePos = latLngToVec3(node.lat, node.lng, 1.003);

        // Tangent-space orientation: Z = outward, X = east-west, Y = north-south
        const outward = pos.clone().normalize();
        const rawEast = new THREE.Vector3().crossVectors(outward, new THREE.Vector3(0, 1, 0));
        const eastDir = rawEast.lengthSq() > 0.01 ? rawEast.normalize() : new THREE.Vector3(1, 0, 0);
        const northDir = new THREE.Vector3().crossVectors(eastDir, outward).normalize();
        const satQuat = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(eastDir, northDir, outward),
        );

        // Flat satellite body (appears as square when viewed from outside)
        const bodyGeo = new THREE.BoxGeometry(0.013, 0.013, 0.004);
        const bodyMat = new THREE.MeshBasicMaterial({ color: colorHex });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.copy(pos);
        body.quaternion.copy(satQuat);
        group.add(body);
        nodeMapRef.current.set(body, node);

        // Solar panel wings (extend east-west)
        const wingGeo = new THREE.BoxGeometry(0.02, 0.003, 0.003);
        const wingMat = new THREE.MeshBasicMaterial({ color: 0x7a7a24 });
        for (const side of [1, -1]) {
          const wing = new THREE.Mesh(wingGeo, wingMat);
          wing.position.copy(pos).addScaledVector(eastDir, side * 0.016);
          wing.quaternion.copy(satQuat);
          group.add(wing);
        }

        // Signal beam cone: tip at satellite, base spreading at surface
        const beamHeight = satRadius - 1.003;
        const beamMid = new THREE.Vector3().addVectors(pos, surfacePos).multiplyScalar(0.5);
        const coneGeo = new THREE.ConeGeometry(0.108, beamHeight, 6, 1, true);
        const coneMat = new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.03,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.copy(beamMid);
        // Align cone's +Y axis with the outward (satellite→surface is -outward, so apex at +Y = satellite side)
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
        group.add(cone);
      } else {
        // ── Archiver (sphere + halo ring) ────────────────────────────────────
        const radius =
          node.status === 'synced'
            ? 1.025
            : node.status === 'lagging'
              ? 1.03
              : node.status === 'behind'
                ? 1.035
                : node.status === 'offline'
                  ? 1.04
                  : 1.025;

        const mat = new THREE.MeshBasicMaterial({ color: colorHex });
        const dot = new THREE.Mesh(archiverDotGeo, mat);
        const pos = latLngToVec3(node.lat, node.lng, radius);
        dot.position.copy(pos);
        group.add(dot);
        nodeMapRef.current.set(dot, node);

        const ringGeo = new THREE.RingGeometry(0.025, 0.035, 16);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x00aaff,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        ring.lookAt(pos.clone().multiplyScalar(2));
        group.add(ring);
      }
    }
  }, [signature]);

  return (
    <div className="globe-wrapper">
      <div className="globe-mount" ref={mountRef} />
      <div className="wave-key">
        <span>BLOCK ARRIVAL</span>
        <span className="wave-ramp" />
        <span className="wave-ends">
          <span>first</span>
          <span>
            +{Math.round(waveMax).toLocaleString('en-US')} ms{waveSlow > 1 ? ` · slowed ${waveSlow}×` : ''}
          </span>
        </span>
      </div>
      <div ref={tooltipRef} className="globe-node-tooltip" style={{ display: 'none' }} />
    </div>
  );
}
