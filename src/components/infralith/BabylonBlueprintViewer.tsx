'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import { animate } from 'animejs';
import {
  ArcRotateCamera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { GeometricReconstruction } from '@/ai/flows/infralith/reconstruction-types';

type BabylonBlueprintViewerProps = {
  data: GeometricReconstruction | null;
  progress: number;
  isTopView?: boolean;
};

const hexToColor3 = (hex: string | undefined, fallback = '#cccccc') => {
  const safe = (hex || fallback).replace('#', '');
  if (safe.length !== 6) return Color3.FromHexString(fallback);
  return Color3.FromHexString(`#${safe}`);
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export default function BabylonBlueprintViewer({ data, progress, isTopView = false }: BabylonBlueprintViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const rootRef = useRef<TransformNode | null>(null);
  const cameraRef = useRef<ArcRotateCamera | null>(null);

  const bounds = useMemo(() => {
    if (!data?.walls?.length) return null;
    const allX = data.walls.flatMap((w) => [w.start[0], w.end[0]]);
    const allZ = data.walls.flatMap((w) => [w.start[1], w.end[1]]);
    return {
      minX: Math.min(...allX),
      maxX: Math.max(...allX),
      minZ: Math.min(...allZ),
      maxZ: Math.max(...allZ),
    };
  }, [data]);

  useEffect(() => {
    if (!canvasRef.current) return;

    const engine = new Engine(canvasRef.current, true, { antialias: true, preserveDrawingBuffer: true }, true);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.95, 0.95, 0.92, 1);

    const camera = new ArcRotateCamera('camera', -Math.PI / 3, Math.PI / 3, 45, new Vector3(0, 0, 0), scene);
    camera.attachControl(canvasRef.current, true);
    camera.wheelPrecision = 20;
    camera.lowerRadiusLimit = 6;
    camera.upperRadiusLimit = 220;

    new HemisphericLight('hemi', new Vector3(0.2, 1, 0.2), scene);

    engine.runRenderLoop(() => {
      scene.render();
    });

    const handleResize = () => engine.resize();
    window.addEventListener('resize', handleResize);

    engineRef.current = engine;
    sceneRef.current = scene;
    cameraRef.current = camera;

    return () => {
      window.removeEventListener('resize', handleResize);
      scene.dispose();
      engine.dispose();
      rootRef.current = null;
      sceneRef.current = null;
      engineRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera) return;

    if (rootRef.current) {
      rootRef.current.dispose();
      rootRef.current = null;
    }

    const root = new TransformNode('blueprint-root', scene);
    rootRef.current = root;

    const ground = MeshBuilder.CreateGround('ground', { width: 240, height: 240 }, scene);
    const groundMat = new StandardMaterial('ground-mat', scene);
    groundMat.diffuseColor = new Color3(0.72, 0.79, 0.62);
    groundMat.specularColor = new Color3(0, 0, 0);
    ground.material = groundMat;
    ground.position.y = -0.02;
    ground.parent = root;

    if (!data?.walls?.length) {
      root.scaling.y = clamp(progress || 0.01, 0.01, 1);
      return;
    }

    const centerX = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
    const centerZ = bounds ? (bounds.minZ + bounds.maxZ) / 2 : 0;
    const footprint = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) : 20;
    const suggestedRadius = clamp(footprint * 2.1, 18, 170);

    camera.setTarget(new Vector3(centerX, 1.4, centerZ));
    if (isTopView) {
      camera.alpha = -Math.PI / 2;
      camera.beta = 0.08;
      camera.radius = clamp(footprint * 2.3, 18, 180);
    } else {
      camera.alpha = -Math.PI / 3;
      camera.beta = Math.PI / 3.1;
      camera.radius = suggestedRadius;
    }

    const wallMap = new Map<string, { cx: number; cz: number; dx: number; dz: number; len: number; ang: number; baseY: number; thickness: number }>();

    for (const wall of data.walls) {
      const dx = wall.end[0] - wall.start[0];
      const dz = wall.end[1] - wall.start[1];
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < 0.05) continue;

      const cx = (wall.start[0] + wall.end[0]) / 2;
      const cz = (wall.start[1] + wall.end[1]) / 2;
      const baseY = (wall.floor_level || 0) * 2.8;
      const thickness = Math.max(0.05, wall.thickness || 0.115);
      const wallHeight = Math.max(1.6, wall.height || 2.8);
      const ang = Math.atan2(dz, dx);

      const mesh = MeshBuilder.CreateBox(`wall-${String(wall.id)}`, {
        width: len,
        height: wallHeight,
        depth: thickness,
      }, scene);
      mesh.position = new Vector3(cx, baseY + wallHeight / 2, cz);
      mesh.rotation = new Vector3(0, -ang, 0);
      const mat = new StandardMaterial(`wall-mat-${String(wall.id)}`, scene);
      mat.diffuseColor = hexToColor3(wall.color, wall.is_exterior ? '#f5e6d3' : '#faf7f2');
      mat.specularColor = new Color3(0.04, 0.04, 0.04);
      mesh.material = mat;
      mesh.parent = root;

      wallMap.set(String(wall.id), { cx, cz, dx, dz, len, ang, baseY, thickness });
    }

    for (const room of data.rooms || []) {
      if (!Array.isArray(room.polygon) || room.polygon.length < 3) continue;
      const points = room.polygon as [number, number][];
      const rx = points.reduce((s, p) => s + p[0], 0) / points.length;
      const rz = points.reduce((s, p) => s + p[1], 0) / points.length;
      const minX = Math.min(...points.map((p) => p[0]));
      const maxX = Math.max(...points.map((p) => p[0]));
      const minZ = Math.min(...points.map((p) => p[1]));
      const maxZ = Math.max(...points.map((p) => p[1]));
      const rw = Math.max(0.2, maxX - minX);
      const rd = Math.max(0.2, maxZ - minZ);
      const ry = (room.floor_level || 0) * 2.8;

      const slab = MeshBuilder.CreateBox(`room-${String(room.id)}`, { width: rw, height: 0.04, depth: rd }, scene);
      slab.position = new Vector3(rx, ry + 0.02, rz);
      const slabMat = new StandardMaterial(`room-mat-${String(room.id)}`, scene);
      slabMat.diffuseColor = hexToColor3(room.floor_color, '#e8d5b7');
      slabMat.specularColor = new Color3(0, 0, 0);
      slab.material = slabMat;
      slab.parent = root;
    }

    const createOpeningMesh = (
      id: string,
      hostWallId: string | number,
      position: [number, number],
      width: number,
      height: number,
      color: string,
      yCenter: number
    ) => {
      const host = wallMap.get(String(hostWallId));
      if (!host || host.len <= 0) return;
      const relX = position[0] - (host.cx - host.dx / 2);
      const relZ = position[1] - (host.cz - host.dz / 2);
      const dist = (relX * host.dx + relZ * host.dz) / host.len;
      const localX = clamp(dist - host.len / 2, -host.len / 2, host.len / 2);
      const wx = host.cx + Math.cos(host.ang) * localX;
      const wz = host.cz + Math.sin(host.ang) * localX;

      const mesh = MeshBuilder.CreateBox(id, {
        width: Math.max(0.2, width),
        height: Math.max(0.2, height),
        depth: Math.max(0.06, host.thickness + 0.03),
      }, scene);
      mesh.position = new Vector3(wx, yCenter, wz);
      mesh.rotation = new Vector3(0, -host.ang, 0);
      const mat = new StandardMaterial(`${id}-mat`, scene);
      mat.diffuseColor = hexToColor3(color, '#8b4513');
      mat.specularColor = new Color3(0.02, 0.02, 0.02);
      mesh.material = mat;
      mesh.parent = root;
    };

    for (const door of data.doors || []) {
      const host = wallMap.get(String(door.host_wall_id));
      if (!host) continue;
      createOpeningMesh(
        `door-${String(door.id)}`,
        door.host_wall_id,
        door.position,
        door.width,
        door.height,
        door.color || '#8b4513',
        host.baseY + door.height / 2
      );
    }

    for (const win of data.windows || []) {
      const host = wallMap.get(String(win.host_wall_id));
      if (!host) continue;
      const winHeight = 1.2;
      createOpeningMesh(
        `window-${String(win.id)}`,
        win.host_wall_id,
        win.position,
        win.width,
        winHeight,
        win.color || '#87ceeb',
        host.baseY + win.sill_height + winHeight / 2
      );
    }

    root.scaling.y = 0.01;
    animate(root.scaling, {
      y: clamp(progress || 1, 0.05, 1),
      duration: 900,
      easing: 'easeOutExpo',
    });
  }, [bounds, data, isTopView, progress]);

  useEffect(() => {
    if (!rootRef.current) return;
    const nextY = clamp(progress || 0.01, 0.01, 1);
    animate(rootRef.current.scaling, {
      y: nextY,
      duration: 220,
      easing: 'easeOutQuad',
    });
  }, [progress]);

  return <canvas ref={canvasRef} className="w-full h-full" />;
}
