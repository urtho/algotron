import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { NodeState } from '../types/index.js';

interface Props {
  nodes: NodeState[];
  healthyRelays: number;
  healthyArchivers: number;
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
    camera.position.z = 2.8;

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
    const atmoGeo = new THREE.SphereGeometry(1.05, 32, 32);
    const atmoMat = new THREE.MeshPhongMaterial({
      color: 0x0044aa,
      transparent: true,
      opacity: 0.06,
      side: THREE.BackSide,
    });
    globeGroup.add(new THREE.Mesh(atmoGeo, atmoMat));

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

    // ── Slow rotation ─────────────────────────────────────────────────────────
    let lastTime = performance.now();

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      globeGroup.rotation.y += 0.04 * dt; // ~2.4°/s
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
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
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
    while (group.children.length) {
      const child = group.children[0] as THREE.Mesh;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
      group.remove(child);
    }

    const dotGeo = new THREE.SphereGeometry(0.018, 8, 8);

    for (const node of nodes) {
      if (node.lat === 0 && node.lng === 0) continue;

      const colorHex = node.type === 'archiver'
        ? ARCHIVER_COLOR
        : (STATUS_COLORS[node.status] ?? STATUS_COLORS.unknown);

      const mat = new THREE.MeshBasicMaterial({ color: colorHex });
      const dot = new THREE.Mesh(dotGeo, mat);

      const pos = latLngToVec3(node.lat, node.lng, 1.025);
      dot.position.copy(pos);
      group.add(dot);

      // Halo ring for archivers
      if (node.type === 'archiver') {
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
    </div>
  );
}
