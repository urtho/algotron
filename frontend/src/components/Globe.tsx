import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { NodeState } from '../types/index.js';

interface Props {
  nodes: NodeState[];
  healthyRelays: number;
  healthyArchivers: number;
}

// GeoJSON geometry types we care about
interface GeoPolygon      { type: 'Polygon';      coordinates: number[][][];  }
interface GeoMultiPolygon { type: 'MultiPolygon'; coordinates: number[][][][]; }
type GeoGeometry = GeoPolygon | GeoMultiPolygon | { type: string };
interface GeoFeature { geometry: GeoGeometry; }

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

const STATUS_COLORS: Record<string, number> = {
  synced: 0x00ff88,
  lagging: 0xffff00,
  orange: 0xff8800,
  offline: 0xff2222,
  unknown: 0x336655,
};

const ARCHIVER_COLOR = 0x00aaff;

export function Globe({ nodes, healthyRelays, healthyArchivers }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const dotsGroupRef = useRef<THREE.Group | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef = useRef<number>(0);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const nodeMapRef = useRef<Map<THREE.Object3D, NodeState>>(new Map());
  const tooltipRef = useRef<HTMLDivElement>(null);

  // ── Initial Three.js setup (runs once) ──────────────────────────────────────
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const w = container.clientWidth;
    const h = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.z = 3.36;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // ── Globe sphere ──────────────────────────────────────────────────────────
    const globeGroup = new THREE.Group();
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
      const opacity = Math.pow(1 - t, 1.4) * 0.82;
      if (opacity < 0.01) continue;

      const pts: THREE.Vector3[] = [];
      for (let lat = -87; lat <= 87; lat += 3) {
        pts.push(latLngToVec3(lat, lngOffset, 1.004));
      }

      scanGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xffff00, transparent: true, opacity }),
      ));
    }

    // ── Node dots group ───────────────────────────────────────────────────────
    const dotsGroup = new THREE.Group();
    globeGroup.add(dotsGroup);
    dotsGroupRef.current = dotsGroup;

    // ── Lights ────────────────────────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x112244, 1.5);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0x3366ff, 1.2);
    sun.position.set(5, 3, 5);
    scene.add(sun);

    // ── Continent contours ────────────────────────────────────────────────────
    let destroyed = false;
    const landMat = new THREE.LineBasicMaterial({
      color: 0x00662e,
      transparent: true,
      opacity: 0.8,
    });

    void fetch('https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_land.geojson')
      .then(r => r.json())
      .then((geojson: { features: GeoFeature[] }) => {
        if (destroyed) return;
        const contourGroup = new THREE.Group();

        function addRing(coords: number[][]) {
          if (coords.length < 2) return;
          const pts = coords.map(([lng, lat]) => latLngToVec3(lat, lng, 1.002));
          contourGroup.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            landMat,
          ));
        }

        for (const f of geojson.features) {
          const g = f.geometry;
          if (g.type === 'Polygon') {
            for (const ring of (g as GeoPolygon).coordinates) addRing(ring);
          } else if (g.type === 'MultiPolygon') {
            for (const poly of (g as GeoMultiPolygon).coordinates)
              for (const ring of poly) addRing(ring);
          }
        }

        globeGroup.add(contourGroup);
      });

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
        ((e.clientX - rect.left) / rect.width)  *  2 - 1,
        ((e.clientY - rect.top)  / rect.height) * -2 + 1,
      );
      raycasterRef.current.setFromCamera(mouse, camera);
      const hits = raycasterRef.current.intersectObjects(
        dotsGroupRef.current ? dotsGroupRef.current.children : [],
        false,
      );
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (hits.length > 0) {
        const node = nodeMapRef.current.get(hits[0].object);
        if (node) {
          tooltip.textContent = `${node.label} · ${node.status}`;
          tooltip.style.left = `${e.clientX - rect.left + 14}px`;
          tooltip.style.top  = `${e.clientY - rect.top  - 10}px`;
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
    container.addEventListener('pointerdown',  onPointerDown);
    container.addEventListener('pointermove',  onPointerMove);
    container.addEventListener('pointerup',    onPointerUp);
    container.addEventListener('pointercancel',onPointerUp);
    container.addEventListener('pointerleave', onPointerLeave);

    // ── Slow rotation & scan ──────────────────────────────────────────────────
    let lastTime = performance.now();
    let scanAngle = 0;
    const _tempColor  = new THREE.Color();
    const _whiteColor = new THREE.Color(0xffffff);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      if (!isDragging) globeGroup.rotation.y += 0.04 * dt; // ~2.4°/s
      scanAngle += (2 * Math.PI / 2.8) * dt; // one full revolution per 2.8 s
      scanGroup.rotation.y = scanAngle;

      // ── Scanner glow: brighten & enlarge nodes under the leading meridian ───
      for (const [dot, node] of nodeMapRef.current) {
        // Node's angle in globeGroup x-z plane: lng=0 → angle 0, lng=90 → -π/2
        const nodeAngle = -node.lng * (Math.PI / 180);
        let diff = ((-scanAngle - nodeAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI; // normalise to (-π, π]

        const intensity = Math.max(0, 1 - Math.abs(diff + 0.18) / 0.22); // peak 0.18 rad behind leading edge
        const baseHex = node.type === 'archiver'
          ? ARCHIVER_COLOR
          : (STATUS_COLORS[node.status] ?? STATUS_COLORS.unknown);
        const mat = (dot as THREE.Mesh).material as THREE.MeshBasicMaterial;
        _tempColor.set(baseHex);
        mat.color.lerpColors(_tempColor, _whiteColor, intensity * 0.75);
        (dot as THREE.Mesh).scale.setScalar(1 + intensity * 0.5);
      }

      renderer.render(scene, camera);
    };
    animate();

    // ── Resize observer ───────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      const nw = container.clientWidth;
      const nh = container.clientHeight;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    return () => {
      destroyed = true;
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      container.removeEventListener('pointerdown',  onPointerDown);
      container.removeEventListener('pointermove',  onPointerMove);
      container.removeEventListener('pointerup',    onPointerUp);
      container.removeEventListener('pointercancel',onPointerUp);
      container.removeEventListener('pointerleave', onPointerLeave);
      renderer.dispose();
      renderer.domElement.remove();
      rendererRef.current = null;
      dotsGroupRef.current = null;
    };
  }, []);

  // ── Sync node dots when `nodes` changes ──────────────────────────────────────
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

    for (const node of nodes) {
      if (node.lat === 0 && node.lng === 0) continue;

      const colorHex = node.type === 'archiver'
        ? ARCHIVER_COLOR
        : (STATUS_COLORS[node.status] ?? STATUS_COLORS.unknown);

      if (node.type === 'relay') {
        // ── Satellite-style relay ────────────────────────────────────────────
        const satRadius =
          node.status === 'synced'  ? 1.10 :
          node.status === 'lagging' ? 1.11 :
          node.status === 'orange'  ? 1.12 :
          node.status === 'offline' ? 1.13 : 1.10;

        const pos        = latLngToVec3(node.lat, node.lng, satRadius);
        const surfacePos = latLngToVec3(node.lat, node.lng, 1.003);

        // Tangent-space orientation: Z = outward, X = east-west, Y = north-south
        const outward = pos.clone().normalize();
        const rawEast = new THREE.Vector3().crossVectors(outward, new THREE.Vector3(0, 1, 0));
        const eastDir = rawEast.lengthSq() > 0.01
          ? rawEast.normalize()
          : new THREE.Vector3(1, 0, 0);
        const northDir = new THREE.Vector3().crossVectors(eastDir, outward).normalize();
        const satQuat = new THREE.Quaternion().setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(eastDir, northDir, outward),
        );

        // Flat satellite body (appears as square when viewed from outside)
        const bodyGeo = new THREE.BoxGeometry(0.013, 0.013, 0.004);
        const bodyMat = new THREE.MeshBasicMaterial({ color: colorHex });
        const body    = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.copy(pos);
        body.quaternion.copy(satQuat);
        group.add(body);
        nodeMapRef.current.set(body, node);

        // Solar panel wings (extend east-west)
        const wingGeo = new THREE.BoxGeometry(0.020, 0.003, 0.003);
        const wingMat = new THREE.MeshBasicMaterial({ color: 0x7a7a24 });
        for (const side of [1, -1]) {
          const wing = new THREE.Mesh(wingGeo, wingMat);
          wing.position.copy(pos).addScaledVector(eastDir, side * 0.016);
          wing.quaternion.copy(satQuat);
          group.add(wing);
        }

        // Signal beam cone: tip at satellite, base spreading at surface
        const beamHeight = satRadius - 1.003;
        const beamMid    = new THREE.Vector3().addVectors(pos, surfacePos).multiplyScalar(0.5);
        const coneGeo    = new THREE.ConeGeometry(0.108, beamHeight, 6, 1, true);
        const coneMat    = new THREE.MeshBasicMaterial({
          color: colorHex, transparent: true, opacity: 0.03,
          side: THREE.DoubleSide, depthWrite: false,
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.copy(beamMid);
        // Align cone's +Y axis with the outward (satellite→surface is -outward, so apex at +Y = satellite side)
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
        group.add(cone);

      } else {
        // ── Archiver (sphere + halo ring) ────────────────────────────────────
        const radius =
          node.status === 'synced'  ? 1.025 :
          node.status === 'lagging' ? 1.030  :
          node.status === 'orange'  ? 1.035  :
          node.status === 'offline' ? 1.040  : 1.025;

        const mat = new THREE.MeshBasicMaterial({ color: colorHex });
        const dot = new THREE.Mesh(archiverDotGeo, mat);
        const pos = latLngToVec3(node.lat, node.lng, radius);
        dot.position.copy(pos);
        group.add(dot);
        nodeMapRef.current.set(dot, node);

        const ringGeo = new THREE.RingGeometry(0.025, 0.035, 16);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x00aaff, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        ring.lookAt(pos.clone().multiplyScalar(2));
        group.add(ring);
      }
    }
  }, [nodes]);

  return (
    <div className="globe-wrapper">
      <div className="globe-counter globe-counter-left">
        <span className="counter-label">RELAYS</span>
        <span className="counter-value relay-color">{healthyRelays}</span>
      </div>
      <div className="globe-counter globe-counter-right">
        <span className="counter-value archiver-color">{healthyArchivers}</span>
        <span className="counter-label">ARCHIVERS</span>
      </div>
      <div className="globe-mount" ref={mountRef} />
      <div ref={tooltipRef} className="globe-node-tooltip" style={{ display: 'none' }} />
    </div>
  );
}
