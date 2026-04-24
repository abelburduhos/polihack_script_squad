// =============================================================================
// 3D globe for the home page. Wireframe Earth with a glowing marker on Romania.
// Auto-rotates; scroll position pulls the camera in and tilts the globe.
// =============================================================================
(function () {
  const canvas = document.getElementById("globe-canvas");
  if (!canvas || typeof THREE === "undefined") return;

  const scene = new THREE.Scene();

  function getSize() {
    return {
      w: canvas.clientWidth || window.innerWidth,
      h: canvas.clientHeight || window.innerHeight,
    };
  }

  let { w, h } = getSize();
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 0, 3);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);

  // ----- Globe -----
  const globe = new THREE.Group();
  scene.add(globe);

  const radius = 1;

  // Solid inner sphere (gives the wireframe something behind it)
  const sphereGeo = new THREE.SphereGeometry(radius, 64, 48);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0x0d1620,
    transparent: true,
    opacity: 0.92,
  });
  globe.add(new THREE.Mesh(sphereGeo, sphereMat));

  // Wireframe overlay
  const wireGeo = new THREE.SphereGeometry(radius * 1.001, 36, 24);
  const wireMat = new THREE.MeshBasicMaterial({
    color: 0x3a86b5,
    wireframe: true,
    transparent: true,
    opacity: 0.45,
  });
  globe.add(new THREE.Mesh(wireGeo, wireMat));

  // Outer atmosphere glow (soft, larger sphere)
  const glowGeo = new THREE.SphereGeometry(radius * 1.07, 48, 36);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x5fb3f8,
    transparent: true,
    opacity: 0.05,
    side: THREE.BackSide,
  });
  globe.add(new THREE.Mesh(glowGeo, glowMat));

  // ----- Romania marker -----
  function latLngToVec3(lat, lng, r) {
    const phi = ((90 - lat) * Math.PI) / 180;
    const theta = ((lng + 180) * Math.PI) / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta)
    );
  }

  const RO_LAT = 45.94;
  const RO_LNG = 24.97;
  const roPos = latLngToVec3(RO_LAT, RO_LNG, radius * 1.01);

  const dotMat = new THREE.MeshBasicMaterial({ color: 0xff5b3b });
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 16), dotMat);
  dot.position.copy(roPos);
  globe.add(dot);

  // Pulsing ring at marker
  const ringGeo = new THREE.RingGeometry(0.035, 0.06, 48);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff5b3b,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(roPos);
  ring.lookAt(0, 0, 0);
  globe.add(ring);

  // Tilt globe slightly so Romania peeks toward camera
  globe.rotation.y = -((RO_LNG + 180) * Math.PI) / 180 + Math.PI / 2;
  globe.rotation.x = -0.35;

  let baseY = globe.rotation.y;

  // ----- Scroll progress (spans the whole page so the globe stays in motion) -----
  let scrollProgress = 0;
  function updateScroll() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    scrollProgress = Math.max(0, Math.min(1, window.scrollY / max));
  }
  window.addEventListener("scroll", updateScroll, { passive: true });
  updateScroll();

  // ----- Resize -----
  function onResize() {
    const s = getSize();
    w = s.w;
    h = s.h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener("resize", onResize);

  // ----- Animate -----
  const cfg = (typeof CONFIG !== "undefined" && CONFIG.home) || {
    autoRotateSpeed: 0.0025,
    scrollZoom: 0.9,
    scrollTilt: 0.35,
  };

  let t = 0;
  function animate() {
    requestAnimationFrame(animate);
    t += 0.016;

    // Slower rotation as user scrolls
    baseY += cfg.autoRotateSpeed * (1 - scrollProgress * 0.8);
    globe.rotation.y = baseY;
    globe.rotation.x = -0.35 - scrollProgress * cfg.scrollTilt;

    // Camera zooms in
    camera.position.z = 3 - scrollProgress * cfg.scrollZoom;

    // Pulsing ring around Romania
    const pulse = 1 + Math.sin(t * 2.4) * 0.18;
    ring.scale.set(pulse, pulse, pulse);
    ringMat.opacity = 0.5 - Math.sin(t * 2.4) * 0.25;

    renderer.render(scene, camera);
  }
  animate();
})();
