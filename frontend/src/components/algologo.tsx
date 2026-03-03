import * as THREE from "three";

export function algoLogo() {
  // Parse SVG polygon points
  const pointsString =
    "444.18 444.32 406.81 444.32 382.54 354.04 330.36 444.33 288.64 444.33 369.29 304.57 356.31 256.05 247.56 444.36 205.82 444.36 343.64 205.64 380.18 205.64 396.18 264.95 433.88 264.95 408.14 309.71 444.18 444.32";
  const coords = pointsString.trim().split(/\s+/).map(Number);

  // Create THREE.Shape from polygon points
  const shape = new THREE.Shape();
  // Scale down and center the coordinates (SVG viewBox is 0-650)
  const scale = 0.015; // Scale factor to make it reasonably sized
  const offsetX = 325; // Center X (650/2)
  const offsetY = 325; // Center Y (650/2)

  // Move to first point
  shape.moveTo((coords[0] - offsetX) * scale, -(coords[1] - offsetY) * scale);

  // Line to remaining points
  for (let i = 2; i < coords.length; i += 2) {
    shape.lineTo(
      (coords[i] - offsetX) * scale,
      -(coords[i + 1] - offsetY) * scale,
    );
  }

  // Extrude settings
  const extrudeSettings = {
    depth: 0.5,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 5,
  };

  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  //const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const material = new THREE.MeshPhongMaterial({
    color: 0x00ff00, // Green base color
    specular: 0x80ff80,
    shininess: 75, // Shiny effect
  });

  const algo = new THREE.Mesh(geometry, material);

  algo.translateZ(-0.2);
  algo.translateX(-0.55);

  const pivot = new THREE.Group();
  pivot.add(algo);
  //pivot.add(pipe);

  //algo.translateZ(1.25);
  pivot.translateY(0.25);

  return pivot;
}
