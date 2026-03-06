'use client';

import { useEffect, useMemo, useRef } from 'react';
import { animate } from 'animejs';
import {
  ArcRotateCamera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
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

const DEFAULT_FLOOR_HEIGHT = 2.8;
const MIN_FLOOR_HEIGHT = 2.2;

type FloorMetrics = {
  levels: number[];
  floorHeightByLevel: Map<number, number>;
  floorBaseByLevel: Map<number, number>;
  fallbackHeight: number;
};

const normalizeFloorLevel = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
};

const computeFloorMetrics = (model: GeometricReconstruction | null): FloorMetrics => {
  const levels = new Set<number>();
  const addLevel = (value: unknown) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    levels.add(Math.max(0, Math.round(parsed)));
  };

  for (const wall of model?.walls || []) addLevel(wall.floor_level);
  for (const room of model?.rooms || []) addLevel(room.floor_level);
  for (const door of model?.doors || []) addLevel(door.floor_level);
  for (const win of model?.windows || []) addLevel(win.floor_level);
  for (const item of model?.furnitures || []) addLevel(item.floor_level);

  if (levels.size === 0) levels.add(0);

  const hintedCountRaw = Number(model?.meta?.floor_count);
  const hintedCount = Number.isFinite(hintedCountRaw) ? Math.max(0, Math.round(hintedCountRaw)) : 0;
  const maxDetected = Math.max(...levels);
  const maxLevel = Math.max(0, maxDetected, hintedCount > 0 ? hintedCount - 1 : 0);
  const orderedLevels = Array.from({ length: maxLevel + 1 }, (_, level) => level);

  const floorHeightByLevel = new Map<number, number>();
  for (const wall of model?.walls || []) {
    const floorLevel = normalizeFloorLevel(wall.floor_level);
    const wallHeight = Math.max(
      MIN_FLOOR_HEIGHT,
      Number.isFinite(Number(wall.height)) ? Number(wall.height) : DEFAULT_FLOOR_HEIGHT
    );
    const current = floorHeightByLevel.get(floorLevel) || 0;
    floorHeightByLevel.set(floorLevel, Math.max(current, wallHeight));
  }

  const sampledHeights = [...floorHeightByLevel.values()].filter((height) => Number.isFinite(height) && height > 0);
  const averageHeight =
    sampledHeights.length > 0
      ? sampledHeights.reduce((sum, height) => sum + height, 0) / sampledHeights.length
      : DEFAULT_FLOOR_HEIGHT;
  const fallbackHeight = Math.max(MIN_FLOOR_HEIGHT, Number(averageHeight.toFixed(3)));

  const floorBaseByLevel = new Map<number, number>();
  let runningY = 0;
  for (const level of orderedLevels) {
    floorBaseByLevel.set(level, Number(runningY.toFixed(3)));
    runningY += floorHeightByLevel.get(level) || fallbackHeight;
  }

  return {
    levels: orderedLevels,
    floorHeightByLevel,
    floorBaseByLevel,
    fallbackHeight,
  };
};

const resolveFloorBaseY = (metrics: FloorMetrics, floorLevel: unknown): number => {
  const level = normalizeFloorLevel(floorLevel);
  const mapped = metrics.floorBaseByLevel.get(level);
  if (mapped != null) return mapped;
  if (metrics.levels.length === 0) return 0;
  const maxKnownLevel = metrics.levels[metrics.levels.length - 1];
  const maxKnownBase = metrics.floorBaseByLevel.get(maxKnownLevel) || 0;
  const extensionHeight = metrics.floorHeightByLevel.get(maxKnownLevel) || metrics.fallbackHeight;
  if (level <= maxKnownLevel) return level * metrics.fallbackHeight;
  return maxKnownBase + ((level - maxKnownLevel) * extensionHeight);
};

const resolveFloorHeight = (metrics: FloorMetrics, floorLevel: unknown): number => {
  const level = normalizeFloorLevel(floorLevel);
  return metrics.floorHeightByLevel.get(level) || metrics.fallbackHeight;
};

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
  const floorMetrics = useMemo(() => computeFloorMetrics(data), [data]);

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

    for (const level of floorMetrics.levels) {
      const floorWalls = (data.walls || []).filter((wall) => normalizeFloorLevel(wall.floor_level) === level);
      const footprintWalls = floorWalls.length > 0 ? floorWalls : (data.walls || []);
      const levelX = footprintWalls.flatMap((wall) => [wall.start[0], wall.end[0]]);
      const levelZ = footprintWalls.flatMap((wall) => [wall.start[1], wall.end[1]]);
      if (levelX.length === 0 || levelZ.length === 0) continue;

      const minX = Math.min(...levelX);
      const maxX = Math.max(...levelX);
      const minZ = Math.min(...levelZ);
      const maxZ = Math.max(...levelZ);
      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      const sizeX = (maxX - minX) + 40;
      const sizeZ = (maxZ - minZ) + 40;
      const slabY = resolveFloorBaseY(floorMetrics, level);
      const levelHeight = resolveFloorHeight(floorMetrics, level);

      const slab = MeshBuilder.CreateBox(`level-slab-${level}`, {
        width: Math.max(0.2, sizeX),
        height: 0.04,
        depth: Math.max(0.2, sizeZ),
      }, scene);
      slab.position = new Vector3(centerX, slabY + 0.02, centerZ);
      const slabMat = new StandardMaterial(`level-slab-mat-${level}`, scene);
      slabMat.diffuseColor = new Color3(0.94, 0.94, 0.94);
      slabMat.specularColor = new Color3(0.02, 0.02, 0.02);
      slabMat.alpha = 0.28;
      slab.material = slabMat;
      slab.parent = root;

      const hasLevelAbove = floorMetrics.levels.some((nextLevel) => nextLevel > level);
      const shouldRenderCeiling = hasLevelAbove || !data.roof;
      if (shouldRenderCeiling) {
        const ceiling = MeshBuilder.CreateBox(`level-ceiling-${level}`, {
          width: Math.max(0.2, sizeX),
          height: 0.03,
          depth: Math.max(0.2, sizeZ),
        }, scene);
        ceiling.position = new Vector3(centerX, slabY + levelHeight - 0.015, centerZ);
        const ceilingMat = new StandardMaterial(`level-ceiling-mat-${level}`, scene);
        ceilingMat.diffuseColor = new Color3(0.96, 0.95, 0.92);
        ceilingMat.specularColor = new Color3(0.01, 0.01, 0.01);
        ceilingMat.alpha = 0.35;
        ceiling.material = ceilingMat;
        ceiling.parent = root;
      }
    }

    for (const wall of data.walls) {
      const dx = wall.end[0] - wall.start[0];
      const dz = wall.end[1] - wall.start[1];
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < 0.05) continue;

      const cx = (wall.start[0] + wall.end[0]) / 2;
      const cz = (wall.start[1] + wall.end[1]) / 2;
      const baseY = resolveFloorBaseY(floorMetrics, wall.floor_level) + Number(wall.base_offset || 0);
      const thickness = Math.max(0.05, wall.thickness || 0.115);
      const wallHeight = Math.max(1.6, wall.height || floorMetrics.fallbackHeight);
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
      const floorLevel = normalizeFloorLevel(room.floor_level);
      const ry = resolveFloorBaseY(floorMetrics, floorLevel);
      const ceilingY = ry + resolveFloorHeight(floorMetrics, floorLevel) - 0.015;

      const slab = MeshBuilder.CreateBox(`room-${String(room.id)}`, { width: rw, height: 0.04, depth: rd }, scene);
      slab.position = new Vector3(rx, ry + 0.02, rz);
      const slabMat = new StandardMaterial(`room-mat-${String(room.id)}`, scene);
      slabMat.diffuseColor = hexToColor3(room.floor_color, '#e8d5b7');
      slabMat.specularColor = new Color3(0, 0, 0);
      slab.material = slabMat;
      slab.parent = root;

      const ceiling = MeshBuilder.CreateBox(`room-ceiling-${String(room.id)}`, { width: rw, height: 0.03, depth: rd }, scene);
      ceiling.position = new Vector3(rx, ceilingY, rz);
      const ceilingMat = new StandardMaterial(`room-ceiling-mat-${String(room.id)}`, scene);
      ceilingMat.diffuseColor = new Color3(0.96, 0.95, 0.92);
      ceilingMat.specularColor = new Color3(0.01, 0.01, 0.01);
      ceilingMat.alpha = 0.26;
      ceiling.material = ceilingMat;
      ceiling.parent = root;
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
  }, [bounds, data, floorMetrics, isTopView, progress]);

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
