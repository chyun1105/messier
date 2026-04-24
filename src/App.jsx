import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const HYG_CSV_URL = "https://raw.githubusercontent.com/kiloquad/__HYG-Database/master/hygdata_v3.csv";
const MESSIER_CSV_URL = "https://raw.githubusercontent.com/lgbouma/obs/master/data/catalogs/messier.csv";

const SKY_RADIUS = 1000;
const DEG = Math.PI / 180;

const FALLBACK_MESSIER = [
  { id: 1, name: "M1 Crab Nebula", type: "SNR", ra: 5.575, dec: 22.017 },
  { id: 13, name: "M13 Hercules Globular Cluster", type: "GC", ra: 16.695, dec: 36.467 },
  { id: 31, name: "M31 Andromeda Galaxy", type: "G", ra: 0.712, dec: 41.269 },
  { id: 42, name: "M42 Orion Nebula", type: "DN", ra: 5.591, dec: -5.391 },
  { id: 45, name: "M45 Pleiades", type: "OC", ra: 3.783, dec: 24.117 },
  { id: 57, name: "M57 Ring Nebula", type: "PN", ra: 18.893, dec: 33.033 },
  { id: 81, name: "M81 Bode's Galaxy", type: "G", ra: 9.925, dec: 69.067 },
  { id: 104, name: "M104 Sombrero Galaxy", type: "G", ra: 12.667, dec: -11.617 },
];

const NAMED_REFERENCE_STARS = new Set([
  "Sirius", "Canopus", "Arcturus", "Vega", "Capella", "Rigel", "Procyon", "Betelgeuse",
  "Altair", "Aldebaran", "Spica", "Antares", "Pollux", "Fomalhaut", "Deneb", "Regulus", "Polaris",
]);

function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseMessierCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const header = parseCSVLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines
    .slice(1)
    .map((line) => {
      const c = parseCSVLine(line);
      const id = Number(c[idx.messier_id]);
      const comment = (c[idx.comments] || "").replace(/^b'|'$/g, "");
      const type = c[idx.type] || "";
      const ra = Number(c[idx.ra]);
      const dec = Number(c[idx.dec]);
      return { id, name: `M${id}${comment ? ` ${comment}` : ""}`, type, ra, dec };
    })
    .filter((o) => Number.isFinite(o.id) && Number.isFinite(o.ra) && Number.isFinite(o.dec))
    .sort((a, b) => a.id - b.id);
}

function parseHygCSV(text, limitingMag) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const header = parseCSVLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const stars = [];
  const labels = [];

  for (const line of lines.slice(1)) {
    const c = parseCSVLine(line);
    const ra = Number(c[idx.ra]);
    const dec = Number(c[idx.dec]);
    const mag = Number(c[idx.mag]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag)) continue;
    if (mag > limitingMag) continue;

    const proper = c[idx.proper] || "";
    const bf = c[idx.bf] || "";
    const spect = c[idx.spect] || "";
    const star = { ra, dec, mag, proper, bf, spect };
    stars.push(star);

    if ((proper && NAMED_REFERENCE_STARS.has(proper)) || mag <= 1.3) labels.push(star);
  }

  return { stars, labels };
}

function raDecToVector(raHours, decDeg, radius = SKY_RADIUS) {
  // RA 좌우 반전 문제 수정: 화면에서 동서가 기존 코드와 반대로 나오던 것을 뒤집는다.
  const ra = raHours * 15 * DEG;
  const dec = decDeg * DEG;
  const x = -radius * Math.cos(dec) * Math.sin(ra);
  const y = radius * Math.sin(dec);
  const z = -radius * Math.cos(dec) * Math.cos(ra);
  return new THREE.Vector3(x, y, z);
}

function vectorToRaDec(v) {
  const n = v.clone().normalize();
  const dec = Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)) / DEG;
  const raRad = Math.atan2(-n.x, -n.z);
  const ra = ((raRad / DEG) / 15 + 24) % 24;
  return { ra, dec };
}

function angularDistanceDeg(a, b) {
  const ra1 = a.ra * 15 * DEG;
  const ra2 = b.ra * 15 * DEG;
  const dec1 = a.dec * DEG;
  const dec2 = b.dec * DEG;
  const cosD =
    Math.sin(dec1) * Math.sin(dec2) +
    Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
  return Math.acos(THREE.MathUtils.clamp(cosD, -1, 1)) / DEG;
}

function scoreFromError(errorDeg) {
  if (errorDeg <= 0.5) return 100;
  if (errorDeg >= 30) return 0;
  return Math.round(100 * (1 - (errorDeg - 0.5) / 29.5));
}

function spectralColor(spect) {
  const s = (spect || "").trim().toUpperCase();
  if (s.startsWith("O")) return [0.63, 0.73, 1.0];
  if (s.startsWith("B")) return [0.72, 0.80, 1.0];
  if (s.startsWith("A")) return [0.86, 0.90, 1.0];
  if (s.startsWith("F")) return [1.0, 0.96, 0.82];
  if (s.startsWith("G")) return [1.0, 0.88, 0.62];
  if (s.startsWith("K")) return [1.0, 0.68, 0.42];
  if (s.startsWith("M")) return [1.0, 0.48, 0.32];
  return [0.9, 0.92, 1.0];
}

function starSizeFromMag(mag) {
  // 1등급 차이마다 약 2배 크기 차이. 6등급 별을 0.75px 기준으로 둔다.
  return THREE.MathUtils.clamp(0.75 * Math.pow(2, 6 - mag), 0.7, 36);
}

function starBrightnessFromMag(mag) {
  // 밝은 별일수록 훨씬 강한 광량을 주어 기준별이 확실히 튀게 한다.
  return THREE.MathUtils.clamp(Math.pow(2.15, 6 - mag), 0.18, 12.0);
}

function makeTextSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 54px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(2,6,23,0.95)";
  ctx.fillStyle = "rgba(255,255,255,0.98)";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(70, 35, 1);
  return sprite;
}

function Button({ children, onClick, variant = "primary" }) {
  return <button onClick={onClick} className={`button ${variant}`}>{children}</button>;
}

export default function App() {
  const mountRef = useRef(null);
  const labelLayerRef = useRef(null);
  const sceneRef = useRef(null);
  const cameraRef = useRef(null);
  const rendererRef = useRef(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const markerRef = useRef(null);
  const answerRef = useRef(null);
  const lineRef = useRef(null);
  const selectedMessierLabelRef = useRef(null);
  const starLabelsRef = useRef([]);
  const rafRef = useRef(null);
  const pointerRef = useRef({ down: false, moved: false, x: 0, y: 0 });
  const yawPitchRef = useRef({ yaw: 0.0, pitch: 0.0 });
  const fovRef = useRef(42);
  const showLabelsRef = useRef(true);
  const showBrightStarsRef = useRef(true);

  const [stars, setStars] = useState([]);
  const [starLabels, setStarLabels] = useState([]);
  const [messier, setMessier] = useState(FALLBACK_MESSIER);
  const [question, setQuestion] = useState(null);
  const [guess, setGuess] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [limitingMag, setLimitingMag] = useState(6.0);
  const [showLabels, setShowLabels] = useState(true);
  const [showBrightStars, setShowBrightStars] = useState(true);
  const [showMessierDots, setShowMessierDots] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedMessier, setSelectedMessier] = useState(null);
  const [loadingText, setLoadingText] = useState("별 데이터 로딩 중…");
  const [fov, setFov] = useState(42);

  useEffect(() => {
    showLabelsRef.current = showLabels;
    showBrightStarsRef.current = showBrightStars;
  }, [showLabels, showBrightStars]);

  const result = useMemo(() => {
    if (!question || !guess) return null;
    const error = angularDistanceDeg(guess, question);
    return { error, score: scoreFromError(error) };
  }, [guess, question]);

  function nextQuestion() {
    const next = messier[Math.floor(Math.random() * messier.length)];
    setQuestion(next);
    setGuess(null);
    setRevealed(false);
  }

  function resetQuizView() {
    setGuess(null);
    setRevealed(false);
    setSelectedMessier(null);
    yawPitchRef.current = { yaw: 0, pitch: 0 };
    fovRef.current = 42;
    const camera = cameraRef.current;
    if (camera) {
      camera.fov = 42;
      camera.updateProjectionMatrix();
    }
    setFov(42);
    updateCameraLook();
  }

  function updateCameraLook() {
    const camera = cameraRef.current;
    if (!camera) return;
    const { yaw, pitch } = yawPitchRef.current;
    camera.position.set(0, 0, 0);
    camera.rotation.order = "YXZ";
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    camera.rotation.z = 0;
  }

  function recenterOnQuestion() {
    if (!question) return;
    const v = raDecToVector(question.ra, question.dec, 1).normalize();
    yawPitchRef.current.yaw = Math.atan2(v.x, -v.z);
    yawPitchRef.current.pitch = -Math.asin(THREE.MathUtils.clamp(v.y, -1, 1));
    updateCameraLook();
  }

  useEffect(() => {
    fetch(MESSIER_CSV_URL)
      .then((r) => r.text())
      .then((text) => {
        const parsed = parseMessierCSV(text);
        if (parsed.length >= 100) setMessier(parsed);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingText(`HYG 실제 별 카탈로그 로딩 중… 제한등급 ${limitingMag.toFixed(1)}`);
    fetch(HYG_CSV_URL)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const parsed = parseHygCSV(text, limitingMag);
        setStars(parsed.stars);
        setStarLabels(parsed.labels);
        setLoadingText(`HYG 별 ${parsed.stars.length.toLocaleString()}개 표시 중 / 제한등급 ${limitingMag.toFixed(1)}`);
      })
      .catch(() => {
        if (!cancelled) setLoadingText("HYG 별 데이터 로드 실패. 인터넷 또는 CORS를 확인해라.");
      });
    return () => { cancelled = true; };
  }, [limitingMag]);

  useEffect(() => {
    if (!question && messier.length) nextQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messier.length]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020617);

    const camera = new THREE.PerspectiveCamera(fovRef.current, 1, 0.1, 2500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);

    const celestialGrid = new THREE.Group();
    const gridMaterial = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.55 });
    const equatorMaterial = new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.6 });

    function makeLine(points, material) {
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geom, material);
      celestialGrid.add(line);
    }

    for (let dec = -60; dec <= 60; dec += 30) {
      const pts = [];
      for (let ra = 0; ra <= 24.001; ra += 0.1) pts.push(raDecToVector(ra % 24, dec, SKY_RADIUS * 0.998));
      makeLine(pts, dec === 0 ? equatorMaterial : gridMaterial);
    }
    for (let ra = 0; ra < 24; ra += 2) {
      const pts = [];
      for (let dec = -85; dec <= 85; dec += 2) pts.push(raDecToVector(ra, dec, SKY_RADIUS * 0.998));
      makeLine(pts, gridMaterial);
    }
    scene.add(celestialGrid);

    const markerGeom = new THREE.SphereGeometry(3.4, 16, 16);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.95 });
    const marker = new THREE.Mesh(markerGeom, markerMat);
    marker.visible = false;
    scene.add(marker);
    markerRef.current = marker;

    const answerGeom = new THREE.SphereGeometry(4.2, 16, 16);
    const answerMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.95 });
    const answer = new THREE.Mesh(answerGeom, answerMat);
    answer.visible = false;
    scene.add(answer);
    answerRef.current = answer;

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.8 })
    );
    line.visible = false;
    scene.add(line);
    lineRef.current = line;

    sceneRef.current = scene;
    cameraRef.current = camera;
    rendererRef.current = renderer;

    function resize() {
      const rect = mount.getBoundingClientRect();
      const w = Math.max(300, rect.width);
      const h = Math.max(300, rect.height);
      renderer.setSize(w, h, true);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    function animate() {
      rafRef.current = requestAnimationFrame(animate);
      updateCameraLook();

      const starCloud = scene.getObjectByName("stars");
      if (starCloud?.material?.uniforms?.zoomScale) {
        const rawScale = Math.pow(42 / fovRef.current, 0.8);
        starCloud.material.uniforms.zoomScale.value = THREE.MathUtils.clamp(rawScale, 0.85, 2.4);
      }

      renderer.render(scene, camera);
      updateLabels();
    }

    function updateLabels() {
      const layer = labelLayerRef.current;
      if (!layer || !cameraRef.current || !rendererRef.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const cameraDir = new THREE.Vector3();
      camera.getWorldDirection(cameraDir);

      starLabelsRef.current.forEach(({ el, vector }) => {
        if (!showLabelsRef.current || !showBrightStarsRef.current) {
          el.style.display = "none";
          return;
        }
        const dir = vector.clone().normalize();
        if (cameraDir.dot(dir) <= 0) {
          el.style.display = "none";
          return;
        }
        const projected = vector.clone().project(camera);
        if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.15 || Math.abs(projected.y) > 1.15) {
          el.style.display = "none";
          return;
        }
        el.style.display = "block";
        el.style.left = `${((projected.x + 1) / 2) * rect.width}px`;
        el.style.top = `${((-projected.y + 1) / 2) * rect.height}px`;
      });
    }

    resize();
    updateCameraLook();
    animate();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !stars.length) return;

    const old = scene.getObjectByName("stars");
    if (old) {
      old.geometry.dispose();
      old.material.dispose();
      scene.remove(old);
    }

    const positions = new Float32Array(stars.length * 3);
    const colors = new Float32Array(stars.length * 3);
    const sizes = new Float32Array(stars.length);

    stars.forEach((s, i) => {
      const v = raDecToVector(s.ra, s.dec, SKY_RADIUS);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;

      const [r, g, b] = spectralColor(s.spect);
      const brightness = starBrightnessFromMag(s.mag);
      colors[i * 3] = r * brightness;
      colors[i * 3 + 1] = g * brightness;
      colors[i * 3 + 2] = b * brightness;
      sizes[i] = starSizeFromMag(s.mag);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("customColor", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      vertexColors: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        pixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        zoomScale: { value: 1.0 },
      },
      vertexShader: `
        uniform float pixelRatio;
        uniform float zoomScale;
        attribute vec3 customColor;
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = customColor;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * pixelRatio * zoomScale;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 p = gl_PointCoord - vec2(0.5);
          float d = length(p);
          if (d > 0.5) discard;

          float core = 1.0 - smoothstep(0.0, 0.16, d);
          float halo = 1.0 - smoothstep(0.05, 0.5, d);
          float alpha = max(core, halo * 0.58);
          vec3 col = vColor * (1.45 + core * 3.1 + halo * 0.75);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const cloud = new THREE.Points(geometry, material);
    cloud.name = "stars";
    cloud.visible = showBrightStars;
    scene.add(cloud);
  }, [stars, showBrightStars]);

  useEffect(() => {
    const layer = labelLayerRef.current;
    if (!layer) return;
    layer.innerHTML = "";
    starLabelsRef.current = starLabels.map((s) => {
      const el = document.createElement("div");
      el.className = "starLabel";
      el.textContent = s.proper || s.bf || "";
      layer.appendChild(el);
      return { el, vector: raDecToVector(s.ra, s.dec, SKY_RADIUS) };
    });
  }, [starLabels]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const old = scene.getObjectByName("messierDots");
    if (old) {
      scene.remove(old);
      old.children.forEach((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
    }

    const group = new THREE.Group();
    group.name = "messierDots";
    group.visible = showMessierDots;
    const geom = new THREE.SphereGeometry(4.5, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0.86, depthTest: false });
    messier.forEach((m) => {
      const dot = new THREE.Mesh(geom, mat);
      dot.position.copy(raDecToVector(m.ra, m.dec, SKY_RADIUS * 0.985));
      dot.userData = { type: "messier", messier: m };
      group.add(dot);
    });
    scene.add(group);
  }, [messier, showMessierDots]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (selectedMessierLabelRef.current) {
      const old = selectedMessierLabelRef.current;
      scene.remove(old);
      old.material?.map?.dispose?.();
      old.material?.dispose?.();
      selectedMessierLabelRef.current = null;
    }

    if (!selectedMessier || !showMessierDots) return;

    const sprite = makeTextSprite(`M${selectedMessier.id}`);
    sprite.position.copy(raDecToVector(selectedMessier.ra, selectedMessier.dec, SKY_RADIUS * 0.94));
    selectedMessierLabelRef.current = sprite;
    scene.add(sprite);
  }, [selectedMessier, showMessierDots]);

  useEffect(() => {
    const marker = markerRef.current;
    const answer = answerRef.current;
    const line = lineRef.current;
    if (!marker || !answer || !line) return;

    if (guess) {
      marker.visible = true;
      marker.position.copy(raDecToVector(guess.ra, guess.dec, SKY_RADIUS * 0.97));
    } else marker.visible = false;

    if (question && (revealed || guess)) {
      answer.visible = true;
      answer.position.copy(raDecToVector(question.ra, question.dec, SKY_RADIUS * 0.965));
    } else answer.visible = false;

    if (guess && question) {
      const a = raDecToVector(guess.ra, guess.dec, SKY_RADIUS * 0.96);
      const b = raDecToVector(question.ra, question.dec, SKY_RADIUS * 0.96);
      line.geometry.setFromPoints([a, b]);
      line.visible = true;
    } else line.visible = false;
  }, [guess, question, revealed]);

  function onPointerDown(e) {
    pointerRef.current = { down: true, moved: false, x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e) {
    const p = pointerRef.current;
    if (!p.down) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
    p.x = e.clientX;
    p.y = e.clientY;

    yawPitchRef.current.yaw += dx * 0.0032;
    yawPitchRef.current.pitch += dy * 0.0032;
  }

  function onPointerUp(e) {
    const p = pointerRef.current;
    if (!p.down) return;
    pointerRef.current.down = false;
    if (p.moved) return;
    submitGuess(e);
  }

  function onWheel(e) {
    e.preventDefault();
    const camera = cameraRef.current;
    if (!camera) return;
    // 휠/트랙패드 줌을 부드럽게: 한 번 스크롤에 과하게 확대되지 않도록 지수형 변화 사용
    const zoomFactor = Math.exp(e.deltaY * 0.0012);
    const next = THREE.MathUtils.clamp(fovRef.current * zoomFactor, 10, 110);
    fovRef.current = next;
    camera.fov = next;
    camera.updateProjectionMatrix();
    setFov(next);
  }

  function submitGuess(e) {
    if (!question || !cameraRef.current || !rendererRef.current) return;
    const rect = rendererRef.current.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    );

    const raycaster = raycasterRef.current;
    raycaster.setFromCamera(mouse, cameraRef.current);

    if (showMessierDots) {
      const group = sceneRef.current?.getObjectByName("messierDots");
      if (group) {
        const hits = raycaster.intersectObjects(group.children, false);
        if (hits.length > 0) {
          setSelectedMessier(hits[0].object.userData.messier);
          return;
        }
      }
    }

    const direction = raycaster.ray.direction.clone().normalize();
    const g = vectorToRaDec(direction);
    setGuess(g);

    const error = angularDistanceDeg(g, question);
    const score = scoreFromError(error);
    setSelectedMessier(null);
  }

  return (
    <div className="app">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #020617; }
        .app { width: 100vw; height: 100vh; overflow: hidden; background: #020617; color: #e2e8f0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .container { width: 100vw; height: 100vh; position: relative; }
        .header { position: fixed; z-index: 10; left: 18px; top: 18px; right: 18px; display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; pointer-events: none; }
        .eyebrow { color: #94a3b8; font-size: 14px; margin-bottom: 4px; }
        h1 { font-size: clamp(24px, 3.4vw, 42px); margin: 0; letter-spacing: -0.045em; }
        .subtitle { color: #cbd5e1; margin-top: 6px; font-size: 14px; }
        .buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; pointer-events: auto; }
        .button { border: 0; border-radius: 14px; padding: 10px 14px; font-weight: 850; cursor: pointer; white-space: nowrap; backdrop-filter: blur(10px); }
        .button.primary { background: #e2e8f0; color: #020617; }
        .button.secondary { background: rgba(30,41,59,.78); color: #e2e8f0; border: 1px solid #334155; }
        .layout { width: 100vw; height: 100vh; }
        .card { background: rgba(15, 23, 42, .55); border: 1px solid rgba(148,163,184,.22); border-radius: 22px; padding: 16px; box-shadow: 0 20px 70px rgba(0,0,0,.28); backdrop-filter: blur(14px); }
        .layout > .card:first-child { position: fixed; inset: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
        .skyWrap { position: fixed; inset: 0; overflow: hidden; border: 0; border-radius: 0; background: #000; touch-action: none; }
        .skyMount { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }
        .skyMount canvas { width: 100% !important; height: 100% !important; display: block; }
        .labelLayer { pointer-events: none; position: absolute; inset: 0; overflow: hidden; }
        .starLabel { position: absolute; transform: translate(8px, -10px); color: rgba(226,232,240,.86); text-shadow: 0 1px 4px #000; font-size: 12px; white-space: nowrap; }
        .hud { position: fixed; z-index: 8; left: 18px; bottom: 18px; padding: 10px 12px; border-radius: 14px; background: rgba(2,6,23,.50); border: 1px solid rgba(148,163,184,.22); backdrop-filter: blur(10px); color: #cbd5e1; font-size: 13px; pointer-events: none; }
        .question { font-size: 44px; font-weight: 950; line-height: 1; color: #fff; }
        .side { position: fixed; z-index: 9; right: 18px; bottom: 18px; width: min(300px, calc(100vw - 36px)); display: flex; flex-direction: column; gap: 12px; pointer-events: auto; transform: translateZ(0); }
        .cardTitle { font-size: 20px; font-weight: 950; margin-bottom: 10px; }
        .score { font-size: 46px; font-weight: 950; margin: 4px 0; }
        .muted { color: #cbd5e1; }
        .faint { color: #94a3b8; font-size: 14px; margin-top: 8px; }
        .controls { display: grid; gap: 10px; }
        .rangeRow { display: grid; gap: 6px; }
        input[type="range"] { width: 100%; }
        .toggle { border: 1px solid #334155; background: #0f172a; color: #cbd5e1; border-radius: 999px; padding: 8px 11px; cursor: pointer; font-weight: 750; }
        .toggle.on { background: #e2e8f0; color: #020617; }
        .toggleRow { display: flex; gap: 8px; flex-wrap: wrap; }
        @media (max-width: 980px) {
          .header { align-items: flex-start; flex-direction: column; }
          .titleBlock { background: rgba(2,6,23,.48); border: 1px solid rgba(148,163,184,.18); border-radius: 18px; padding: 12px; backdrop-filter: blur(12px); pointer-events: auto; }
          .side { left: 12px; right: 12px; bottom: 12px; width: auto; max-height: 46vh; overflow: auto; }
          .hud { display: none; }
        }
      `}</style>

      <div className="container">
        <div className="header">
          <div className="titleBlock">
            <div className="eyebrow">IOAA Messier Memorizer · 실제 별 카탈로그 기반 3D 천구</div>
            <h1>메시에 천체 위치 퀴즈</h1>
            <div className="subtitle">드래그로 하늘을 돌리고, 휠로 확대/축소한 뒤, M번호의 위치를 클릭해라.</div>
          </div>
          <div className="buttons">
            <Button onClick={nextQuestion}>다음 문제</Button>
            <Button onClick={() => setRevealed((v) => !v)} variant="secondary">정답 보기</Button>
            <Button onClick={recenterOnQuestion} variant="secondary">문제 방향으로 이동</Button>
            <Button onClick={resetQuizView} variant="secondary">성도 초기화</Button>
            <Button onClick={() => setShowSettings((v) => !v)} variant="secondary">표시 설정</Button>
          </div>
        </div>

        <div className="layout">
          <div className="card">
            <div
              className="skyWrap"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => { pointerRef.current.down = false; }}
              onWheel={onWheel}
            >
              <div ref={mountRef} className="skyMount" />
              <div ref={labelLayerRef} className="labelLayer" />
              <div className="hud">
                <div>현재 문제</div>
                <div className="question">{question ? `M${question.id}` : "로딩"}</div>
                <div>{loadingText}</div>
                <div>FOV {Math.round(fov)}°</div>
              </div>
            </div>
          </div>

          <div className="side">
            <div className="card">
              <div className="cardTitle">채점</div>
              {!guess && <div className="muted">드래그는 시야 이동, 클릭은 답 제출이다.</div>}
              {result && (
                <div>
                  <div className="score">{result.score}점</div>
                  <div className="muted">오차: <b>{result.error.toFixed(2)}°</b></div>
                </div>
              )}
            </div>

            {showSettings && (
              <div className="card controls">
                <div className="cardTitle">표시 설정</div>
                <div className="rangeRow">
                  <div className="muted">표시 제한등급: {limitingMag.toFixed(1)}</div>
                  <input
                    type="range"
                    min="3.0"
                    max="10.0"
                    step="0.5"
                    value={limitingMag}
                    onChange={(e) => setLimitingMag(Number(e.target.value))}
                  />
                  <div className="faint">기본값은 6등급. 값을 올리면 더 어두운 별까지 표시된다.</div>
                </div>
                <div className="toggleRow">
                  <button className={`toggle ${showBrightStars ? "on" : ""}`} onClick={() => setShowBrightStars((v) => !v)}>밝은 별 표시</button>
                  <button className={`toggle ${showLabels ? "on" : ""}`} onClick={() => setShowLabels((v) => !v)}>밝은 별 이름</button>
                  <button className={`toggle ${showMessierDots ? "on" : ""}`} onClick={() => setShowMessierDots((v) => !v)}>메시에 점</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
