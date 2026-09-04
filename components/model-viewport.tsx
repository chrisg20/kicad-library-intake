"use client";
/* Renderer initialization reports external WebGL/CAD engine state. */
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRMLLoader } from "three/addons/loaders/VRMLLoader.js";
import { Button } from "@/components/ui/button";
import type { IntakeAsset } from "@/lib/kicad";

type CadMesh = {
  color?: number[];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
  brep_faces?: { first: number; last: number; color?: number[] }[];
};

export function ModelViewport({ asset }: { asset: IntakeAsset }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<() => void>(() => {});
  const cancelRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState("Loading CAD engine…");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b121c");
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    camera.up.set(0, 0, 1);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setStatus("3D rendering requires WebGL. Enable hardware acceleration or try another browser.");
      setReady(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.setAttribute("aria-label", "Shaded 3D model. Drag to orbit, right-drag to pan, scroll to zoom.");
    renderer.domElement.style.touchAction = "none";
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.minDistance = 0.15;
    controls.maxDistance = 30;
    scene.add(new THREE.HemisphereLight(0xddeeff, 0x647080, 2.6));
    const key = new THREE.DirectionalLight(0xffffff, 3);
    key.position.set(3, -4, 6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb8dbff, 1.8);
    fill.position.set(-4, 2, 1);
    scene.add(fill);
    const draw = () => renderer.render(scene, camera);
    controls.addEventListener("change", draw);
    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const stopWorker = () => { worker?.terminate(); clearTimeout(timer); };
    const fail = (message: string) => {
      stopWorker();
      if (!disposed) { setStatus(message); setReady(false); }
    };
    cancelRef.current = () => fail("Preview cancelled. Select the model again to retry.");
    setReady(false);
    setStatus("Meshing CAD surfaces…");
    const show = (object: THREE.Object3D) => {
      if (disposed) return;
      let triangles = 0;
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          triangles += (child.geometry.index?.count ?? child.geometry.attributes.position?.count ?? 0) / 3;
        }
      });
      if (!triangles) throw new Error("No surface geometry found in this model.");
      const box = new THREE.Box3().setFromObject(object);
      const span = Math.max(...box.getSize(new THREE.Vector3()).toArray());
      if (!Number.isFinite(span) || span <= 0) throw new Error("The model has invalid dimensions.");
      const center = box.getCenter(new THREE.Vector3());
      const group = new THREE.Group();
      group.add(object);
      group.scale.setScalar(1 / span);
      group.position.copy(center).multiplyScalar(-1 / span);
      scene.add(group);
      resetRef.current = () => {
        const distance = 0.9 / Math.sin(Math.atan(Math.tan(THREE.MathUtils.degToRad(20)) * Math.min(camera.aspect, 1)));
        camera.position.set(1, -1.5, 1).normalize().multiplyScalar(distance);
        controls.target.set(0, 0, 0);
        controls.update();
        draw();
      };
      resetRef.current();
      setReady(true);
      setStatus(Math.round(triangles).toLocaleString() + " triangles · shaded surfaces");
      stopWorker();
    };
    const material = (rgb?: number[]) => new THREE.MeshStandardMaterial({
      color: rgb ? new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace) : new THREE.Color("#9abfc7"),
      roughness: 0.46, metalness: 0.12, side: THREE.DoubleSide,
    });
    try {
      if (/\.(wrl|vrml)$/i.test(asset.name)) {
        const manager = new THREE.LoadingManager();
        // Never fetch URLs embedded in an uploaded VRML model.
        manager.setURLModifier(() => "data:,");
        show(new VRMLLoader(manager).parse(new TextDecoder().decode(asset.bytes), ""));
      } else {
        const base = (import.meta as ImportMeta & { env: { BASE_URL: string } }).env.BASE_URL;
        worker = new Worker(base + "cad-worker.js");
        timer = setTimeout(() => fail("Meshing timed out after 90 seconds. Try a smaller model."), 90000);
        worker.onerror = () => fail("The CAD engine could not load. Refresh the page and try again.");
        worker.onmessage = ({ data }: MessageEvent<{ error?: string; meshes: CadMesh[] }>) => {
          if (disposed) return;
          if (data.error) { fail(data.error); return; }
          try {
            const object = new THREE.Group();
            for (const mesh of data.meshes) {
              const geometry = new THREE.BufferGeometry();
              geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
              geometry.setIndex(mesh.index.array);
              if (mesh.attributes.normal) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3));
              else geometry.computeVertexNormals();
              const materials = [material(mesh.color)];
              const faces = mesh.brep_faces ?? [];
              if (faces.length) {
                for (const face of faces) {
                  const index = face.color ? materials.push(material(face.color)) - 1 : 0;
                  geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, index);
                }
              }
              object.add(new THREE.Mesh(geometry, faces.length ? materials : materials[0]));
            }
            show(object);
          } catch (error) { fail(error instanceof Error ? error.message : "Unable to render model."); }
        };
        const bytes = new Uint8Array(asset.bytes);
        worker.postMessage({ bytes, name: asset.name }, [bytes.buffer]);
      }
    } catch (error) { fail(error instanceof Error ? error.message : "Unable to render model."); }
    return () => {
      disposed = true;
      stopWorker();
      observer.disconnect();
      controls.dispose();
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          for (const mat of Array.isArray(child.material) ? child.material : [child.material]) mat.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      resetRef.current = () => {};
    };
  }, [asset]);

  return (
    <div className="preview-stage relative">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute top-3 left-3 max-w-[70%] rounded bg-slate-950/85 p-2 text-sm text-slate-200" role="status">{status}</div>
      <Button type="button" variant="outline" className="absolute top-3 right-3" onClick={() => ready ? resetRef.current() : cancelRef.current()}>
        {ready ? "Reset view" : "Cancel"}
      </Button>
      {ready && <span className="preview-grid-label">Drag to orbit · right-drag to pan · scroll or pinch to zoom</span>}
    </div>
  );
}
