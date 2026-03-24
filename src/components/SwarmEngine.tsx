import React, { useEffect, useRef, useState, useCallback } from 'react';
import Joystick from './Joystick';
import { Crown, Shield, Sword, Check, ArrowLeft, Users, Zap,
  WifiOff,
  RefreshCw, Loader2, Trophy, LogOut } from 'lucide-react';
import { cn } from '../utils/cn';

import { EmpireType } from './SelectionScreen';
import { Language, translations, EMPIRE_CURRENCIES } from '../utils/i18n';

export let ENGINE_STATE = 'MENU';

interface SwarmEngineProps {
  initialEmpire: {
    id: EmpireType;
    color: string;
  };
  onBack?: () => void;
  language: Language;
}

const SOCKET_URL = (import.meta as any).env?.VITE_SOCKET_URL || 'https://server-for-sultans-game-production.up.railway.app';
const CLIENT_SYNC_INTERVAL = 50;
const SYNC_PACKET_HEADER_SIZE = 25;
const SYNC_PACKET_UNIT_COUNT_SENTINEL = 0xffffffff;
const syncPacketEncoder = new TextEncoder();

type SocketEventHandler = (data?: any) => void;
type SocketAnyHandler = (eventName: string, data?: any) => void;

const getTransportUrl = (input: string) => {
  const isSecurePage = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const preferredProtocol = isSecurePage ? 'wss:' : 'ws:';

  if (!input) {
    return `${preferredProtocol}//${window.location.host}`;
  }

  try {
    const url = new URL(input);
    if (url.protocol === 'http:' || url.protocol === 'ws:') {
      url.protocol = preferredProtocol;
    } else if (url.protocol === 'https:' || url.protocol === 'wss:') {
      url.protocol = 'wss:';
    }
    return url.toString();
  } catch {
    if (input.startsWith('ws://')) {
      return isSecurePage ? `wss://${input.slice(5)}` : input;
    }
    if (input.startsWith('wss://')) return input;
    if (input.startsWith('/')) {
      return `${preferredProtocol}//${window.location.host}${input}`;
    }
    return `${preferredProtocol}//${input.replace(/^\/+/, '')}`;
  }
};

const createSyncPacket = (payload: Record<string, any> = {}) => {
  const extras = { ...payload };
  delete extras.x;
  delete extras.y;
  delete extras.rotation;
  delete extras.hp;
  delete extras.unitCount;

  const extraBytes = syncPacketEncoder.encode(JSON.stringify(extras));
  const buffer = new ArrayBuffer(SYNC_PACKET_HEADER_SIZE + extraBytes.length);
  const view = new DataView(buffer);
  const x = typeof payload.x === 'number' ? payload.x : Number.NaN;
  const y = typeof payload.y === 'number' ? payload.y : Number.NaN;
  const rotation = typeof payload.rotation === 'number' ? payload.rotation : Number.NaN;
  const hp = typeof payload.hp === 'number' ? payload.hp : Number.NaN;
  const unitCount = typeof payload.unitCount === 'number'
    ? Math.max(0, Math.floor(payload.unitCount))
    : SYNC_PACKET_UNIT_COUNT_SENTINEL;

  view.setFloat32(0, x, true);
  view.setFloat32(4, y, true);
  view.setFloat32(8, rotation, true);
  view.setFloat32(12, hp, true);
  view.setUint32(16, unitCount, true);
  view.setUint8(20, payload.isUnderground ? 1 : 0);
  view.setUint32(21, extraBytes.length, true);
  new Uint8Array(buffer, SYNC_PACKET_HEADER_SIZE).set(extraBytes);

  return buffer;
};

class UwsSocketClient {
  id = '';
  connected = false;
  private readonly url: string;
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<SocketEventHandler>>();
  private readonly anyListeners = new Set<SocketAnyHandler>();
  private readonly pendingMessages: (string | ArrayBuffer)[] = [];
  private manuallyClosed = false;

  constructor(url: string) {
    this.url = getTransportUrl(url);
    this.connect();
  }

  private dispatch(eventName: string, data?: any) {
    if (eventName === 'set_id' && typeof data === 'string') {
      this.id = data;
    }

    this.anyListeners.forEach((handler) => handler(eventName, data));

    const handlers = this.listeners.get(eventName);
    if (!handlers) return;
    handlers.forEach((handler) => handler(data));
  }

  private handleMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;

    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!payload || typeof payload.type !== 'string') return;
    this.dispatch(payload.type, payload.data);
  };

  private sendOrQueue(payload: string | ArrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }

    this.pendingMessages.push(payload);
  }

  private flushPendingMessages() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pendingMessages.length === 0) return;

    while (this.pendingMessages.length > 0) {
      const payload = this.pendingMessages.shift();
      if (payload !== undefined) {
        this.ws.send(payload);
      }
    }
  }

  emit(eventName: string, data?: any) {
    if (eventName === 'sync_data') {
      this.sendOrQueue(createSyncPacket(data));
      return;
    }

    this.sendOrQueue(JSON.stringify({ type: eventName, data }));
  }

  on(eventName: string, handler: SocketEventHandler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(handler);
  }

  off(eventName: string, handler?: SocketEventHandler) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) return;

    if (handler) {
      handlers.delete(handler);
    } else {
      handlers.clear();
    }

    if (handlers.size === 0) {
      this.listeners.delete(eventName);
    }
  }

  onAny(handler: SocketAnyHandler) {
    this.anyListeners.add(handler);
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.manuallyClosed = false;
    this.id = '';
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.connected = true;
      this.flushPendingMessages();
      this.dispatch('connect');
    };

    ws.onerror = () => {
      if (!this.connected) {
        this.dispatch('connect_error');
      }
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected || this.manuallyClosed) {
        this.dispatch('disconnect');
      } else {
        this.dispatch('connect_error');
      }
    };

    ws.onmessage = this.handleMessage;
    this.ws = ws;
  }

  disconnect() {
    this.manuallyClosed = true;
    const activeSocket = this.ws;
    this.ws = null;
    this.connected = false;
    if (activeSocket && (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING)) {
      activeSocket.close();
    }
  }
}

const WORLD_SIZE = 4000;
const LOBBY_WORLD_SIZE = 1200;

interface Village {
  id: string;
  pos: Vector;
  radius: number;
  ownerId: string | null;
  captureProgress: number;
  lastIncomeTime: number;
  color: string;
  name?: string;
}

interface Caravan {
  id: string;
  pos: Vector;
  lastSyncPos?: Vector;
  targetPos: Vector;
  speed: number;
  color: string;
  isReal?: boolean;
  escortOwnerId?: string | null;
  escortTimer?: number;
  lastAkceTime?: number;
  outOfCircleTime?: number;
}
const VIEWPORT_BUFFER = 200;
const UNIT_RADIUS = 10;
const PLAYER_SPEED = 10.125; // 6.75 * 1.5
const DASH_MULTIPLIER = 2.5;
const DASH_COST_PER_FRAME = 0.05;
const MIN_UNITS_TO_DASH = 4;
const COMMANDER_SCALE = 1.8;
const MINIMAP_SIZE = 180;
const BASE_ACCEL = 0.45; 
const BASE_FRICTION = 0.95;
const MASS_INERTIA_FACTOR = 0.0004;
const MELEE_ENGAGEMENT_DIST = 25;
const COMMANDER_MAX_HP = 500;
const TOWER_MAX_HP = 5; // Reduced to 5 hits per request
const WALL_MAX_HP = 10; // 10 hits
const GATE_MAX_HP = 5; // 5 hits
const TOWER_REWARD = 500;
const ARCHER_RANGE = 300;
const PROJECTILE_SPEED = 10;
const PROJECTILE_EXPLOSION_RADIUS = 50;

// --- CONSTRUCTION CONSTANTS ---
const GRID_SIZE = 70;
const WALL_LENGTH = 100; // Physical length for blocking gaps in corners
const DRAW_LENGTH = 70;  // Exact match to GRID_SIZE for perfect tiling
const WALL_THICKNESS = 30; // Physical thickness for collision
const GRID_MARGIN = 2;

const EMPIRE_COLORS = {
  rim: '#1e3a8a', // Russian Blue (matching SelectionScreen)
  fim: '#1e40af', // French Blue (matching SelectionScreen)
  tim: '#991b1b', // Ottoman Red (matching SelectionScreen)
  neutral: '#78350f' // Holop Burlap
};

const SPAWN_POINTS = [
    { x: 500, y: 500 },
    { x: 3500, y: 3500 },
    { x: 500, y: 3500 },
    { x: 3500, y: 500 },
    { x: 2000, y: 500 },
    { x: 2000, y: 3500 },
    { x: 500, y: 2000 },
    { x: 3500, y: 2000 }
];

const UNIT_PRICES = {
    infantry: 10,
    archer: 30,
    tower: 50,
    wall: 10,
    gate: 20
};

type UnitType = 'infantry' | 'tower' | 'wall' | 'gate';

interface Vector { x: number; y: number; }
interface Unit { pos: Vector; color: string; id: string; type: UnitType; hp: number; empireId?: EmpireType | 'neutral'; }
interface Projectile { id: string; ownerId: string; pos: Vector; vel: Vector; life: number; damage: number; color: string; empireId?: EmpireType; targetPos?: Vector; isReal?: boolean; }
interface Tower { id: string; ownerId: string; pos: Vector; color: string; hp: number; maxHp: number; lastShot: number; faction?: string; empireId?: EmpireType; type?: 'tower' | 'wall' | 'gate' | 'tunnel'; rotation?: number; isOpen?: boolean; }
interface Obstacle { id: string; type: 'tree' | 'boulder' | 'grass'; points?: Vector[]; center: Vector; radius: number; color: string; }
interface Garrison { 
  id: string; 
  ownerId: string; 
  units: Unit[]; 
  pos: Vector; 
  color: string; 
  empireId: EmpireType;
  mode: 'HOLD' | 'HUNT' | 'RECALL';
  targetPos?: Vector;
  lastSyncPos?: Vector; // Position from last packet
  lastKnownUnitCount?: number;
  attackTimer: number;
  attackCooldown: number;
  isPulsing?: boolean;
  justSplit: boolean;
  isLocal?: boolean;
  isUnderground?: boolean; // NEW: Layer isolation
  swingKills?: number; // Tracks kills in current swing
  lastDamageTime?: number; // Protection against damage spam
  lastUpdate?: number;
}

interface Entity { 
  id: string; 
  name: string; 
  type: 'player' | 'ai'; 
  units: Unit[]; 
  color: string; 
  faction: string;
  empireId: EmpireType;
  akce: number;
  score: number;
  lastKnownUnitCount?: number;
  isDashing: boolean; 
  velocity: Vector;
  facingAngle: number;
  targetPos?: Vector;
  targetAngle?: number;
  isAttacking: boolean;
  attackTimer: number;
  attackCooldown: number;
  weightSlowdown: number;
  splitCooldown: number;
  stuckTimer?: number;
  lastPos?: Vector;
  panicTimer?: number;
  lastAkceTime?: number;
  hasHitInCurrentSwing?: boolean;
  swingKills?: number;
  lastDamageTime?: number;
  lastUpdate?: number;
  isUnderground?: boolean; // NEW: Underground state
  lastTunnelToggle?: number; // NEW: Cooldown for tunnel entry/exit
  equippedItem?: 'sword' | 'shovel' | 'super_shovel'; // NEW: Inventory
  shovelUses?: number; // NEW: Shovel durability
}

interface TunnelEntrance {
  id: string;
  pos: Vector;
  ownerId: string;
  color: string;
  connectedId?: string; // ID of the exit (if completed)
  createdAt?: number;
}
interface Particle { pos: Vector; vel: Vector; life: number; maxLife: number; color: string; type?: 'dust' | 'slash' | 'tower_dust' | 'ripple' | 'text'; text?: string; }

const getDistance = (v1: Vector, v2: Vector) => Math.sqrt((v1.x - v2.x) ** 2 + (v1.y - v2.y) ** 2);
const generateId = (prefix: string = 'wall') => prefix + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

class SeededRandom {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  next() { this.seed = (this.seed * 9301 + 49297) % 233280; return this.seed / 233280; }
}

class MapGenerator {
  static generate(seed: number, worldSize: number, playerCount: number = 1) {
    const rand = new SeededRandom(seed);
    const obstacles: Obstacle[] = [];
    const activeVillages: Village[] = [];
    const futureVillages: Village[] = [];

    // Villages - Symmetrically placed for fairness
    const villageNames = ['Altın Köy', 'Demir Pazarı', 'İpek Yolu', 'Gümüş Liman', 'Bakır Madeni', 'Tahıl Ambarı', 'Kervan Saray', 'Pazar Yeri', 'Sultan Hanı', 'Hisar Köyü'];
    const numVillages = worldSize < 2000 ? 0 : Math.min(10, Math.max(1, Math.floor(playerCount / 2))); 
    
    for (let i = 0; i < numVillages; i++) {
      let cx, cy;
      
      if (i === 0) {
        // First village is ALWAYS in the exact center
        cx = worldSize / 2;
        cy = worldSize / 2;
      } else {
        // Subsequent villages are placed in a ring around the center
        // Distance is 22% of world size (far enough from spawns, close to center)
        const ringRadius = worldSize * 0.22;
        const angle = ((i - 1) / (numVillages - 1)) * Math.PI * 2;
        cx = worldSize / 2 + Math.cos(angle) * ringRadius;
        cy = worldSize / 2 + Math.sin(angle) * ringRadius;
      }

      const village = {
        id: 'village-' + i,
        pos: { x: cx, y: cy },
        radius: 180,
        ownerId: null,
        captureProgress: 0,
        lastIncomeTime: Date.now(),
        color: '#78350f',
        name: villageNames[i % villageNames.length]
      };

      if (i === 0) {
        activeVillages.push(village);
      } else {
        futureVillages.push(village);
      }
    }

    // Trees
    let treeAttempts = 0;
    for (let i = 0; i < 40 && treeAttempts < 200; i++) {
      treeAttempts++;
      const cx = rand.next() * worldSize, cy = rand.next() * worldSize;
      if (getDistance({x: cx, y: cy}, {x: worldSize/2, y: worldSize/2}) < 200) { i--; continue; }
      obstacles.push({ id: 'tree-'+i, type: 'tree', center: {x: cx, y: cy}, radius: 25 + rand.next()*15, color: '#166534' });
    }
    // Boulders
    let rockAttempts = 0;
    for (let i = 0; i < 25 && rockAttempts < 200; i++) {
      rockAttempts++;
      const cx = rand.next() * worldSize, cy = rand.next() * worldSize;
      if (getDistance({x: cx, y: cy}, {x: worldSize/2, y: worldSize/2}) < 200) { i--; continue; }
      const points: Vector[] = [], n = 5 + Math.floor(rand.next() * 3), r = 40 + rand.next() * 50;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2, dist = r * (0.8 + rand.next() * 0.4);
        points.push({ x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist });
      }
      obstacles.push({ id: 'rock-'+i, type: 'boulder', points, center: {x: cx, y: cy}, radius: r, color: '#475569' });
    }
    // High Grass
    for (let i = 0; i < 15; i++) {
        const cx = rand.next() * worldSize, cy = rand.next() * worldSize;
        obstacles.push({ id: 'grass-'+i, type: 'grass', center: {x: cx, y: cy}, radius: 80 + rand.next() * 100, color: '#14532d' });
    }
    return { obstacles, villages: activeVillages, futureVillages };
  }
}

const drawUnit = (ctx: CanvasRenderingContext2D, x: number, y: number, color: string, isCommander: boolean, angle: number, isAttacking: boolean, attackTimer: number, opacity: number = 1.0, type: UnitType = 'infantry', empireId: EmpireType | 'neutral' = 'neutral', equippedItem?: string) => {
    const scale = isCommander ? COMMANDER_SCALE : 1.0;
    const radius = UNIT_RADIUS * scale;
    const bob = Math.sin(Date.now() * 0.007) * 4;
    
    // Force canonical empire color for the main tunic to ensure identical display for everyone
    let drawColor = EMPIRE_COLORS[empireId as keyof typeof EMPIRE_COLORS] || color;
    
    // Fallback if empireId is unknown or neutral
    if (empireId === 'neutral' && (color === '#94a3b8' || !color)) {
      drawColor = EMPIRE_COLORS.neutral;
    }

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x, y + bob);
    ctx.rotate(angle + Math.PI / 2);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(0, radius * 1.5, radius * 1.2, radius * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (empireId === 'rim') {
      // --- RUSSIAN EMPIRE WARRIOR ---
      if (isCommander) {
        // --- TRICOLOR MANTLE (WHITE-BLUE-RED) ---
        // White (top)
        ctx.fillStyle = '#ffffff'; ctx.beginPath();
        ctx.moveTo(-radius * 1.8, radius * 0.5); ctx.lineTo(radius * 1.8, radius * 0.5);
        ctx.lineTo(radius * 1.8, radius * 1.3); ctx.lineTo(-radius * 1.8, radius * 1.3);
        ctx.fill();
        // Blue (middle)
        ctx.fillStyle = '#1d4ed8'; ctx.beginPath();
        ctx.moveTo(-radius * 1.8, radius * 1.3); ctx.lineTo(radius * 1.8, radius * 1.3);
        ctx.lineTo(radius * 1.8, radius * 2.1); ctx.lineTo(-radius * 1.8, radius * 2.1);
        ctx.fill();
        // Red (bottom)
        ctx.fillStyle = '#ef4444'; ctx.beginPath();
        ctx.moveTo(-radius * 1.8, radius * 2.1); ctx.lineTo(radius * 1.8, radius * 2.1);
        ctx.lineTo(radius * 1.5, radius * 2.8); ctx.lineTo(-radius * 1.5, radius * 2.8);
        ctx.fill();
        
        ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.fillStyle = drawColor; ctx.beginPath(); ctx.rect(-radius * 1.2, radius * 0.4, radius * 2.4, radius * 2.2); ctx.fill();
      
      // Plate Armor
      const plateGrad = ctx.createLinearGradient(-radius, 0, radius, 0);
      plateGrad.addColorStop(0, '#94a3b8'); plateGrad.addColorStop(0.5, '#f1f5f9'); plateGrad.addColorStop(1, '#94a3b8');
      ctx.fillStyle = plateGrad; ctx.beginPath(); ctx.moveTo(-radius * 0.8, radius * 0.6); ctx.lineTo(radius * 0.8, radius * 0.6); ctx.lineTo(radius * 0.7, radius * 2.2); ctx.lineTo(-radius * 0.7, radius * 2.2); ctx.closePath(); ctx.fill();
      
      ctx.fillStyle = '#cbd5e1'; ctx.beginPath(); ctx.arc(-radius * 1.1, radius * 0.8, radius * 0.6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(radius * 1.1, radius * 0.8, radius * 0.6, 0, Math.PI * 2); ctx.fill();
      
      // Shield (only for infantry)
      if (type === 'infantry') {
        ctx.save(); ctx.translate(-radius * 1.4, radius * 1.2); ctx.rotate(Math.PI / 6); ctx.fillStyle = '#451a03'; ctx.beginPath(); ctx.arc(0, 0, radius * 1.1, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 3; ctx.stroke(); ctx.fillStyle = '#94a3b8'; ctx.beginPath(); ctx.arc(0, 0, radius * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }

      const swingProgress = isAttacking ? (300 - attackTimer) / 300 : 0;
      const swingAngle = isAttacking ? Math.PI / 1.5 * Math.sin(swingProgress * Math.PI) : 0;
      ctx.save(); ctx.translate(radius * 1.2, radius * 1.0); ctx.rotate(-swingAngle);
      if (isCommander) {
        if (equippedItem === 'shovel' || equippedItem === 'super_shovel') {
          // --- RUSSIAN STYLE SHOVEL ---
          ctx.strokeStyle = '#5d4037'; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(0, radius); ctx.lineTo(0, -radius * 4); ctx.stroke();
          ctx.fillStyle = equippedItem === 'super_shovel' ? '#fbbf24' : '#94a3b8';
          ctx.beginPath(); ctx.moveTo(-8, -radius * 4); ctx.lineTo(8, -radius * 4); ctx.lineTo(0, -radius * 6); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1; ctx.stroke();
        } else {
          ctx.strokeStyle = '#f1f5f9'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(radius * 1.5, -radius * 1.5, radius * 0.5, -radius * 4.5); ctx.stroke();
          ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.strokeStyle = '#451a03'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, radius); ctx.lineTo(0, -radius * 5); ctx.stroke();
        ctx.fillStyle = '#cbd5e1'; ctx.beginPath(); ctx.moveTo(-4, -radius * 5); ctx.lineTo(4, -radius * 5); ctx.lineTo(0, -radius * 6.5); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = '#ffd6a5'; ctx.beginPath(); ctx.arc(0, 0, radius * 0.9, 0, Math.PI * 2); ctx.fill();
      
      ctx.fillStyle = '#475569'; ctx.beginPath(); ctx.moveTo(-radius * 0.9, radius * 0.3); ctx.lineTo(radius * 0.9, radius * 0.3); ctx.lineTo(radius * 0.7, radius * 0.8); ctx.lineTo(-radius * 0.7, radius * 0.8); ctx.closePath(); ctx.fill();
      const helmetGrad = ctx.createLinearGradient(-radius, -radius, radius, 0);
      helmetGrad.addColorStop(0, '#f1f5f9'); helmetGrad.addColorStop(1, '#64748b');
      ctx.fillStyle = helmetGrad; ctx.beginPath(); ctx.moveTo(-radius, 0); ctx.bezierCurveTo(-radius, -radius * 2.2, radius, -radius * 2.2, radius, 0); ctx.fill();
      ctx.fillStyle = isCommander ? '#fbbf24' : '#94a3b8'; ctx.fillRect(-1.5, -radius * 2.4, 3, radius * 0.8); if (isCommander) { ctx.beginPath(); ctx.arc(0, -radius * 2.4, 4, 0, Math.PI * 2); ctx.fill(); }

    } else if (empireId === 'fim') {
      // --- FRENCH EMPIRE WARRIOR ---
      ctx.fillStyle = drawColor; ctx.beginPath(); ctx.moveTo(-radius * 1.1, radius * 0.4); ctx.lineTo(radius * 1.1, radius * 0.4); ctx.lineTo(radius * 0.8, radius * 2.5); ctx.lineTo(-radius * 0.8, radius * 2.5); ctx.fill();
      ctx.fillStyle = '#fbbf24'; ctx.fillRect(-radius * 1.3, radius * 0.3, radius * 0.6, radius * 0.3); ctx.fillRect(radius * 0.7, radius * 0.3, radius * 0.6, radius * 0.3);

      const swingProgress = isAttacking ? (300 - attackTimer) / 300 : 0;
      const swingAngle = isAttacking ? Math.PI / 1.5 * Math.sin(swingProgress * Math.PI) : 0;
      ctx.save(); ctx.translate(radius * 0.9, radius * 0.8); ctx.rotate(-swingAngle);
      if (isCommander || type === 'infantry') {
        if (equippedItem === 'shovel' || equippedItem === 'super_shovel') {
          // --- FRENCH STYLE SHOVEL ---
          ctx.strokeStyle = '#451a03'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, radius); ctx.lineTo(0, -radius * 4); ctx.stroke();
          ctx.fillStyle = equippedItem === 'super_shovel' ? '#fbbf24' : '#cbd5e1';
          ctx.beginPath(); ctx.ellipse(0, -radius * 4.5, 10, 12, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1; ctx.stroke();
        } else {
          // Draw Sword
          ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2.5 * scale; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(radius * 1.5, -radius * 1.0, radius * 0.5, -radius * 3.5); ctx.stroke();
          ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(0, 0, radius * 0.4, 0, Math.PI*2); ctx.fill();
        }
      }
      ctx.restore();
      ctx.fillStyle = '#ffd6a5'; ctx.beginPath(); ctx.arc(0, 0, radius * 0.85, 0, Math.PI * 2); ctx.fill();
      if (isCommander) {
        ctx.fillStyle = '#18181b'; ctx.beginPath(); ctx.ellipse(0, -radius * 0.5, radius * 1.8, radius * 0.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, -radius * 1.0, radius * 0.3, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(0, -radius * 1.0, radius * 0.15, 0, Math.PI*2); ctx.fill();
      } else {
        ctx.fillStyle = '#18181b'; ctx.fillRect(-radius * 0.8, -radius * 1.8, radius * 1.6, radius * 1.8);
        ctx.fillStyle = '#fbbf24'; ctx.fillRect(-radius * 0.8, -radius * 1.8, radius * 1.6, radius * 0.3);
      }

    } else if (empireId === 'tim') {
      // --- OTTOMAN EMPIRE WARRIOR ---
      const bodyGrad = ctx.createLinearGradient(-radius, 0, radius, 0);
      bodyGrad.addColorStop(0, drawColor); bodyGrad.addColorStop(0.5, isCommander ? '#065f46' : drawColor); bodyGrad.addColorStop(1, drawColor);
      ctx.fillStyle = bodyGrad; ctx.beginPath(); ctx.moveTo(-radius * 1.2, radius * 0.4); ctx.lineTo(radius * 1.2, radius * 0.4); ctx.lineTo(radius * 1.0, radius * 2.5); ctx.lineTo(-radius * 1.0, radius * 2.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1 * scale; ctx.beginPath(); ctx.moveTo(-radius * 1.2, radius * 0.5); ctx.lineTo(radius * 1.2, radius * 0.5); ctx.moveTo(0, radius * 0.5); ctx.lineTo(0, radius * 2.5); ctx.stroke();
      
      const swingProgress = isAttacking ? (300 - attackTimer) / 300 : 0;
      const swingAngle = isAttacking ? Math.PI / 1.5 * Math.sin(swingProgress * Math.PI) : 0;
      ctx.save(); ctx.translate(radius * 1.0, radius * 0.8); ctx.rotate(-swingAngle);
      if (isCommander || type === 'infantry') {
        if (equippedItem === 'shovel' || equippedItem === 'super_shovel') {
          // --- OTTOMAN STYLE SHOVEL ---
          ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, radius); ctx.lineTo(0, -radius * 4); ctx.stroke();
          ctx.fillStyle = equippedItem === 'super_shovel' ? '#fbbf24' : '#cbd5e1';
          ctx.beginPath(); ctx.moveTo(-9, -radius * 4); ctx.lineTo(9, -radius * 4); ctx.quadraticCurveTo(0, -radius * 7, -9, -radius * 4); ctx.fill();
          ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1; ctx.stroke();
        } else {
          ctx.fillStyle = drawColor; ctx.beginPath(); ctx.ellipse(radius * 0.3, -radius * 0.1, radius * 0.5, radius * 0.2, -Math.PI/6, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = '#92400e'; ctx.fillRect(radius * 0.5, -radius * 0.4, radius * 0.4, radius * 0.2);
          ctx.fillStyle = '#fbbf24'; ctx.fillRect(radius * 0.7, -radius * 0.6, radius * 0.1, radius * 0.6);
          ctx.strokeStyle = isAttacking ? '#ff4444' : '#e2e8f0'; ctx.lineWidth = 2.5 * scale; ctx.beginPath(); ctx.moveTo(radius * 0.8, -radius * 0.3); ctx.quadraticCurveTo(radius * 2.5, -radius * 1.5, radius * 1.2, -radius * 3.5); ctx.stroke();
        }
      }
      ctx.restore();

      ctx.fillStyle = '#ffd6a5'; ctx.beginPath(); ctx.arc(0, 0, radius * 0.9, 0, Math.PI * 2); ctx.fill();
      if (isCommander) {
          const hatGrad = ctx.createRadialGradient(0, -radius * 0.8, 0, 0, -radius * 0.8, radius * 1.5);
          hatGrad.addColorStop(0, '#ffffff'); hatGrad.addColorStop(1, '#e2e8f0'); ctx.fillStyle = hatGrad; ctx.beginPath(); ctx.ellipse(0, -radius * 0.8, radius * 1.6, radius * 1.4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#be123c'; ctx.beginPath(); ctx.arc(0, -radius * 1.6, radius * 0.6, 0, Math.PI, true); ctx.fill();
          ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(0, -radius * 1.2); ctx.lineTo(radius * 0.3, -radius * 0.9); ctx.lineTo(0, -radius * 0.6); ctx.lineTo(-radius * 0.3, -radius * 0.9); ctx.closePath(); ctx.fill();
      } else {
          ctx.fillStyle = '#f8fafc'; ctx.beginPath(); ctx.moveTo(-radius * 1.0, -radius * 0.2); ctx.lineTo(radius * 1.0, -radius * 0.2); ctx.lineTo(radius * 0.6, -radius * 3.0); ctx.lineTo(-radius * 0.6, -radius * 3.0); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -radius * 3.0); ctx.quadraticCurveTo(radius * 0.5, -radius * 4.0, radius * 1.2, -radius * 3.5); ctx.stroke();
      }

    } else {
      // --- NEUTRAL "HOLOP" (SERF) STYLE ---
      // Burlap Tunic (Мешковина)
      ctx.fillStyle = '#78350f'; 
      ctx.beginPath(); 
      ctx.moveTo(-radius * 0.9, radius * 0.5); 
      ctx.lineTo(radius * 0.9, radius * 0.5); 
      ctx.lineTo(radius * 0.7, radius * 2.2); 
      ctx.lineTo(-radius * 0.7, radius * 2.2); 
      ctx.fill();
      
      // Rope Belt (Верёвка)
      ctx.strokeStyle = '#d4a373'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-radius * 0.85, radius * 1.2); ctx.lineTo(radius * 0.85, radius * 1.2); ctx.stroke();
      
      // Wooden Stick (Дубина/Палка)
      ctx.strokeStyle = '#451a03'; ctx.lineWidth = 2; 
      ctx.beginPath(); ctx.moveTo(radius * 0.8, radius * 0.8); ctx.lineTo(radius * 1.3, -radius * 2.2); ctx.stroke();
      
      // Face
      ctx.fillStyle = '#ffd6a5'; ctx.beginPath(); ctx.arc(0, 0, radius * 0.8, 0, Math.PI * 2); ctx.fill();
      
      // Messy Hair (Лохматые волосы)
      ctx.fillStyle = '#451a03'; 
      ctx.beginPath(); ctx.arc(0, -radius * 0.2, radius * 0.85, Math.PI, 0); ctx.fill();
      for(let i=0; i<4; i++) { 
        ctx.beginPath(); 
        ctx.arc(-radius * 0.7 + i*radius*0.5, -radius * 0.1, radius * 0.35, 0, Math.PI * 2); 
        ctx.fill(); 
      }
      // Small beard stubble
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.arc(0, radius * 0.3, radius * 0.4, 0, Math.PI); ctx.fill();
    }
    
    ctx.restore();
};

type GameState = 'MENU' | 'CONNECTING' | 'LOBBY_WAITING' | 'GAME_ACTIVE' | 'MATCH_RESULTS';

interface Room {
  id: string;
  name: string;
  password?: string;
  limit?: number;
  maxPlayers?: number;
  players: LobbyPlayer[];
  status: 'Waiting' | 'In-Game' | 'lobby' | 'active' | 'finished';
  isStarted?: boolean;
  rematchVotes: string[] | number;
  hostId: string;
  lastSeen?: number;
  buildings?: any[];
  tunnels?: any[];
  seed?: number;
}

interface LobbyPlayer {
  id: string;
  peerId: string;
  name: string;
  isReady: boolean;
  isHost: boolean;
  empireId?: EmpireType;
}

const SwarmEngine: React.FC<SwarmEngineProps> = ({ initialEmpire, onBack, language }) => {
  const t = translations[language];
  const empireTitles = t.titles[initialEmpire.id as keyof typeof t.titles] || t.titles.tim;
  const playerColor = initialEmpire.color;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameState, setGameState] = useState<GameState>('MENU');
  const gameStateRef = useRef<GameState>(gameState);
  
  // Keep gameStateRef in sync with gameState
  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const [score, setScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<{ name: string, score: number }[]>([]);
  const [isDashing, setIsDashing] = useState(false);
  const playerRef = useRef<Entity | null>(null);
  const entitiesRef = useRef<Entity[]>([]);
  const neutralsRef = useRef<Unit[]>([]);
  const towersRef = useRef<Tower[]>([]);
  const [fps, setFps] = useState(0);
  const fpsRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const framesRef = useRef(0);
  const projectilesRef = useRef<Projectile[]>([]);
  const garrisonsRef = useRef<Garrison[]>([]);
  const recentlyDestroyedGarrisons = useRef<Map<string, number>>(new Map());
  const recentlyDestroyedPlayers = useRef<Map<string, number>>(new Map()); // Player tombstones
  const particlesRef = useRef<Particle[]>([]);
  const pendingRecruitsRef = useRef<Set<string>>(new Set());
  const gameMapRef = useRef<{ obstacles: Obstacle[], villages: Village[], futureVillages?: Village[] }>({ obstacles: [], villages: [], futureVillages: [] });
  const caravansRef = useRef<Caravan[]>([]);
  const joystickDir = useRef<Vector>({ x: 0, y: 0 });
  const keyboardDir = useRef<Vector>({ x: 0, y: 0 });
  const keysRef = useRef<Record<string, boolean>>({}); // Keyboard state ref
  const cameraRef = useRef<Vector>({ x: 0, y: 0 });
  const mouseWorldPosRef = useRef<Vector>({ x: 0, y: 0 });
  const lastWallPosRef = useRef<Vector | null>(null);
  const placementStartPosRef = useRef<Vector | null>(null);
  const placementAxisRef = useRef<'x' | 'y' | null>(null);
  const buildingMapRef = useRef<Map<string, Tower>>(new Map());
  const lastGateToggleTime = useRef<number>(0);
  const tunnelsRef = useRef<TunnelEntrance[]>([]); // NEW: Tunnels
  const [isPlacingWall, setIsPlacingWall] = useState(false);
  const [isPlacingGate, setIsPlacingGate] = useState(false);
  const [isPlacingTower, setIsPlacingTower] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showShop, setShowShop] = useState(false); // NEW: Shop UI
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeSlot, setActiveSlot] = useState(0); // NEW: Minecraft-style active slot (0-8)
  const [nearbyTunnel, setNearbyTunnel] = useState<TunnelEntrance | null>(null); // NEW: For UI interaction
  const isMouseDownRef = useRef(false);

  // Removed duplicate remote_gate_toggled listener - handled in main socket useEffect
  const frameId = useRef<number>(0);
  const shakeRef = useRef<number>(0);
  const worldSizeRef = useRef<number>(WORLD_SIZE);
  const spawnProtectionRef = useRef<boolean>(false);
  const startTimeRef = useRef<number | null>(null);
  const endTimeRef = useRef<number | null>(null);
  const [nickname, setNickname] = useState(() => localStorage.getItem('janissary_nickname') || 'Commander');
  const [stats, setStats] = useState({ total_battles_count: 0, wins_count: 0, total_recruits: 0, total_kills: 0 });
  const [matchStats, setMatchStats] = useState({ duration: '00:00', maxArmy: 1, towersBuilt: 0, kills: 0 });
  const [matchResult, setMatchResult] = useState<{ isWinner: boolean, winnerName: string } | null>(null);
  const [killerName, setKillerName] = useState<string | null>(null);
  const towersBuiltRef = useRef(0);
  const maxArmyRef = useRef(1);
  const killsRef = useRef(0);
  const frameCountRef = useRef(0); // Frame counter for optimization
  const [countdown, setCountdown] = useState<number | null>(null);
  const [kills, setKills] = useState(0);
  const [playerAkce, setPlayerAkce] = useState(0);
  const [totalRecruitsMatch, setTotalRecruitsMatch] = useState(0);
  const [activePlayers, setActivePlayers] = useState(0);
  const [playerGarrisons, setPlayerGarrisons] = useState<Garrison[]>([]);
  const [activeSplitGarrisonId, setActiveSplitGarrisonId] = useState<string | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
  const isSpectatorRef = useRef(false);

  const [isDraggingCamera, setIsDraggingCamera] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(1);
  const cameraZoomRef = useRef(1);
  const [serverCapacity, setServerCapacity] = useState({ active: 0, max: 1000 });
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const isLeavingRef = useRef(false);

  // Spatial Hash Grid for performance optimization
  const GRID_CELL_SIZE = 100;
  const spatialGridRef = useRef<Map<number, { unit: Unit, entityId: string }[]>>(new Map());
  const gridKey = (gx: number, gy: number) => (gx << 16) | (gy & 0xFFFF);

  // Sprite Cache for units to avoid complex path drawing every frame
  const unitSpriteCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Function to get or create a cached unit sprite
  const getUnitSprite = (empireId: EmpireType | 'neutral', isCommander: boolean, color: string, type: UnitType = 'infantry') => {
    const key = `${empireId}_${isCommander}_${color}_${type}`;
    if (unitSpriteCacheRef.current.has(key)) return unitSpriteCacheRef.current.get(key)!;

    // Increased canvas size (160 for units, 240 for commanders) 
    // to accommodate long weapons like spears and yatagans.
    const size = isCommander ? 240 : 160;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    // Draw the unit centered in the cache canvas
    // Using a fixed time/bob for the cached version
    drawUnit(ctx, size / 2, size / 2, color, isCommander, -Math.PI / 2, false, 0, 1.0, type, empireId);

    unitSpriteCacheRef.current.set(key, canvas);
    return canvas;
  };

  useEffect(() => {
    isSpectatorRef.current = isSpectator;
  }, [isSpectator]);

  useEffect(() => {
    cameraZoomRef.current = cameraZoom;
  }, [cameraZoom]);



  // Networking State
  const socketRef = useRef<UwsSocketClient | null>(null);
  const lastSyncTimeRef = useRef<number>(0);
  const lastUIUpdateTimeRef = useRef<number>(0); // NEW: Throttle React state updates
  const [isHost, setIsHost] = useState(false);
  const isHostRef = useRef(false); // NEW: Reliable host ref
  const [myId, setMyId] = useState('');
  const myIdRef = useRef(''); // Ref for myId to avoid closure issues
  useEffect(() => { myIdRef.current = myId; }, [myId]); // Sync ref
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const currentRoomRef = useRef<Room | null>(null);
  const [roomForm, setRoomForm] = useState({ name: '', password: '', limit: 5 });
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const [passwordModalRoom, setPasswordModalRoom] = useState<Room | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  
  // Guard Timer for Loading/Joining states
  useEffect(() => {
    if (isJoiningRoom) {
      const timer = setTimeout(() => {
        if (isJoiningRoom) {
          console.warn("[STABILITY] Join handshake timed out. Resetting...");
          setIsJoiningRoom(false);
          setGameState('MENU');
          ENGINE_STATE = 'MENU';
        }
      }, 8000);
      return () => clearTimeout(timer);
    }
  }, [isJoiningRoom]);
  const [discoveredRooms, setDiscoveredRooms] = useState<Room[]>([]);
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayer[]>([]);
  const lobbyPlayersRef = useRef<LobbyPlayer[]>([]);
  const remotePlayersRef = useRef<Map<string, Entity>>(new Map());
  const playerSkinsRef = useRef<Map<string, { empireId: EmpireType, faction: string, name?: string }>>(new Map());
  const [voteCount, setVoteCount] = useState({ voted: 0, total: 0 });
  const [hasVoted, setHasVoted] = useState(false);
  
  useEffect(() => { currentRoomRef.current = currentRoom; }, [currentRoom]);
  useEffect(() => { lobbyPlayersRef.current = lobbyPlayers; }, [lobbyPlayers]);
  const [networkStatus, setNetworkStatus] = useState<'Connecting...' | 'Ready' | 'Error'>('Connecting...');
  const [socketConnected, setSocketConnected] = useState<boolean>(true);
  const [lastEvent, setLastEvent] = useState<string>('Initializing...');

  const buildTowerFromServerData = useCallback((data: any): Tower | null => {
    const bId = String(data?.buildingId || data?.id || '');
    if (!bId) return null;

    let type: 'wall' | 'gate' | 'tower' | 'tunnel' = 'tower';
    if (data.type === 'WALL' || data.type === 'wall') type = 'wall';
    else if (data.type === 'GATE' || data.type === 'gate') type = 'gate';
    else if (data.type === 'tunnel' || data.type === 'TUNNEL' || data.type === 'pit') type = 'tunnel';

    const maxHp = (type === 'wall' || type === 'gate') ? WALL_MAX_HP : (type === 'tunnel' ? 999999 : TOWER_MAX_HP);
    let bEmpireId = data.empireId;
    if (!bEmpireId || bEmpireId === 'neutral') {
      const owner = entitiesRef.current.find(e => String(e.id) === String(data.ownerId) || e.color === data.faction);
      if (owner) bEmpireId = owner.empireId;
    }

    return {
      id: bId,
      ownerId: String(data.ownerId || data.faction || ''),
      pos: {
        x: Number(data.x ?? data.pos?.x ?? 0),
        y: Number(data.y ?? data.pos?.y ?? 0)
      },
      color: data.faction || data.color || '#94a3b8',
      hp: typeof data.hp === 'number' ? data.hp : maxHp,
      maxHp,
      lastShot: 0,
      type,
      empireId: bEmpireId || 'neutral',
      rotation: typeof data.rotation === 'number' ? data.rotation : 0,
      isOpen: !!data.isOpen
    };
  }, []);

  const buildTunnelFromServerData = useCallback((data: any): TunnelEntrance | null => {
    const tunnelId = String(data?.id || data?.buildingId || '');
    if (!tunnelId) return null;

    return {
      id: tunnelId,
      pos: {
        x: Number(data.x ?? data.pos?.x ?? 0),
        y: Number(data.y ?? data.pos?.y ?? 0)
      },
      ownerId: String(data.ownerId || ''),
      color: data.faction || data.color || '#94a3b8',
      connectedId: data.connectedId,
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : undefined
    };
  }, []);

  const syncRoomStructures = useCallback((roomData?: Room | null) => {
    const rawBuildings = Array.isArray(roomData?.buildings) ? roomData!.buildings : [];
    const rawTunnels = Array.isArray(roomData?.tunnels) ? roomData!.tunnels : [];
    const nextTunnels = rawTunnels
      .map((tunnel) => buildTunnelFromServerData(tunnel))
      .filter((tunnel): tunnel is TunnelEntrance => tunnel !== null);
    const towerMap = new Map<string, Tower>();

    rawBuildings.forEach((building) => {
      const tower = buildTowerFromServerData(building);
      if (tower) towerMap.set(String(tower.id), tower);
    });

    rawTunnels.forEach((tunnel) => {
      const tower = buildTowerFromServerData({ ...tunnel, type: 'tunnel' });
      if (tower) towerMap.set(String(tower.id), tower);
    });

    tunnelsRef.current = nextTunnels;
    towersRef.current = Array.from(towerMap.values());
  }, [buildTowerFromServerData, buildTunnelFromServerData]);

  const syncMyImmediateState = useCallback((ent: Entity) => {
    if (!socketRef.current || !currentRoomRef.current) return;

    const myGarrisons = garrisonsRef.current
      .filter((g) => g.ownerId === ent.id)
      .map((g) => ({
        id: g.id,
        pos: g.pos,
        mode: g.mode,
        unitCount: g.units.length,
        empireId: g.empireId,
        color: g.color,
        attackTimer: g.attackTimer
      }));

    socketRef.current.emit('sync_data', {
      roomId: currentRoomRef.current.id,
      x: ent.units[0]?.pos.x || 0,
      y: ent.units[0]?.pos.y || 0,
      rotation: ent.facingAngle,
      faction: ent.faction,
      empireId: ent.empireId,
      unitCount: Math.max(0, ent.units.length - 1),
      akce: ent.akce,
      hp: ent.units[0]?.hp || COMMANDER_MAX_HP,
      isAttacking: ent.isAttacking,
      isDashing: ent.isDashing,
      isUnderground: ent.isUnderground ?? false,
      equippedItem: ent.equippedItem,
      name: nickname,
      garrisons: myGarrisons
    });
  }, [nickname]);

  const createSplitGarrison = useCallback((ent: Entity, splitCount: number, mode: 'HOLD' | 'HUNT' | 'RECALL') => {
    const normalizedSplitCount = Math.min(Math.max(0, Math.floor(splitCount)), Math.max(0, ent.units.length - 1));
    if (normalizedSplitCount <= 0) return null;

    const splitUnits = ent.units.splice(ent.units.length - normalizedSplitCount, normalizedSplitCount);
    if (splitUnits.length === 0) return null;

    const newGarrison: Garrison = {
      id: generateId('g'),
      ownerId: ent.id,
      units: splitUnits,
      pos: { ...(splitUnits[0]?.pos || ent.units[0]?.pos || { x: 0, y: 0 }) },
      color: ent.color,
      empireId: ent.empireId,
      mode,
      attackTimer: 0,
      attackCooldown: 0,
      justSplit: true,
      isLocal: ent.id === myId,
      isUnderground: ent.isUnderground
    };

    garrisonsRef.current.push(newGarrison);

    if (ent.id === myId) {
      shakeRef.current = 10;
      setPlayerGarrisons([...garrisonsRef.current.filter((g) => g.ownerId === myId)]);
      syncMyImmediateState(ent);
    }

    return newGarrison.id;
  }, [myId, syncMyImmediateState]);

  const getKillerName = (id: string | null): string => {
    if (!id) return 'Enemy';
    
    // Check local entities first (active in game)
    const ent = entitiesRef.current.find(e => e.id === id);
    if (ent) return ent.name;
    
    // Check lobby players (synced names)
    const lobbyP = lobbyPlayersRef.current.find(p => p.id === id);
    if (lobbyP) return lobbyP.name;
    
    // Check player skins cache (historical names)
    const skin = playerSkinsRef.current.get(id);
    if (skin && skin.name) return skin.name;
    
    return 'Enemy';
  };

  const syncRemotePlayers = useCallback((players: LobbyPlayer[]) => {
    const currentIds = new Set(players.map(p => p.id));
    
    // Update lobbyPlayersRef immediately to prevent race conditions in remote_update
    lobbyPlayersRef.current = players;

    // Remove players not in the room
      for (const id of Array.from(remotePlayersRef.current.keys())) {
        if (!currentIds.has(id)) {
          remotePlayersRef.current.delete(id);
          entitiesRef.current = entitiesRef.current.filter(e => e.id !== id);
        }
      }

    // Add or Update players
    players.forEach(p => {
      const myIdVal = socketRef.current?.id || myId;
      if (p.id === myIdVal) return;
      
      const cached = playerSkinsRef.current.get(p.id);
      const factionColor = cached?.faction || '#94a3b8';
      const empireId = p.empireId || cached?.empireId || 'neutral';
      const playerName = p.name || cached?.name || `Janissary_${p.id.substring(0, 3)}`;

      if (!remotePlayersRef.current.has(p.id)) {
        const newEnt: Entity = {
          id: p.id,
          name: playerName,
          type: 'player',
          units: [{ pos: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 }, color: factionColor, id: p.id + '_0', type: 'infantry', hp: 500 }],
          color: factionColor, 
          faction: 'REMOTE',
          empireId: empireId,
          score: 1,
          akce: 0,
          isDashing: false,
          velocity: { x: 0, y: 0 },
          facingAngle: 0,
          isAttacking: false,
          attackTimer: 0,
          attackCooldown: 0,
          weightSlowdown: 0,
          splitCooldown: 0,
          isUnderground: false
        };
        remotePlayersRef.current.set(p.id, newEnt);
        entitiesRef.current.push(newEnt);
      } else {
        // Update existing remote player data if needed (like name)
        const existing = remotePlayersRef.current.get(p.id);
        if (existing) {
          existing.name = playerName;
          existing.empireId = empireId;
        }
      }
    });

  }, [myId]);

  useEffect(() => {
    const socket = new UwsSocketClient(SOCKET_URL);
    socketRef.current = socket;

    socket.onAny((eventName) => {
      setLastEvent(eventName);
    });

    socket.on('connect', () => {
      setNetworkStatus('Ready');
      setSocketConnected(true);
      setLastEvent('Connected');
      if (socket.id) setMyId(socket.id);
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
      setLastEvent('Disconnected');
    });

    socket.on('set_id', (id: string) => {
      setMyId(id || '');
    });

    socket.on('connect_error', () => {
      setNetworkStatus('Error');
      setSocketConnected(false);
      setLastEvent('Connection Error');
    });

    socket.on('room_list', (rooms: Room[]) => {
      setLastEvent('room_list');
      setDiscoveredRooms(Array.isArray(rooms) ? rooms : []);
    });

    socket.on('server_capacity', (data: { active: number, max: number }) => {
      setServerCapacity(data);
    });

    socket.on('queue_update', (data: { position: number }) => {
      setQueuePosition(data.position);
    });

    socket.on('queue_approved', () => {
      setQueuePosition(null);
    });

    socket.on('join_success', (roomData: Room) => {
      setLastEvent('join_success');
      setCurrentRoom(roomData);
      currentRoomRef.current = roomData; // Sync ref immediately
      (window as any).currentRoomId = roomData.id; // Global fallback
      const hostFlag = roomData.hostId === socket.id;
      setIsHost(hostFlag);
      isHostRef.current = hostFlag;
      
      // Forced cleanup before lobby starts
      entitiesRef.current = [];
      remotePlayersRef.current.clear();

      // Update info on server immediately
      socket.emit('update_player_name', { roomId: roomData.id, name: nickname, empireId: initialEmpire.id });
      
      const players = roomData.players || [];
      setLobbyPlayers(players);
      syncRemotePlayers(players);
      setIsCreatingRoom(false);
      setIsJoiningRoom(false);
      setIsMultiplayer(true);
      ENGINE_STATE = 'LOBBY_WAITING';
      setGameState('LOBBY_WAITING');
      gameStateRef.current = 'LOBBY_WAITING';
      startLobbyArena(players);
      syncRoomStructures(roomData);
      if (roomData.players) setLeaderboard(roomData.players.map((p: LobbyPlayer) => ({ name: p.name, score: 0 })));
    });

    socket.on('remote_building_hit', (data: { buildingId: string, hp: number }) => {
      const targetId = String(data.buildingId);
      const b = towersRef.current.find(t => String(t.id) === targetId);
      if (b) {
        b.hp = data.hp;
        createDust(b.pos.x, b.pos.y, b.color);
      }
    });

    socket.on('error', (msg: string) => {
      console.error("[SOCKET ERROR]", msg);
      setLastEvent('error: ' + msg);
      showError(msg);
      setIsCreatingRoom(false);
      setIsJoiningRoom(false);
      setIsSpectator(false);
      setGameState('MENU');
      ENGINE_STATE = 'MENU';
    });

    socket.on('remote_building_destroyed', (data: { buildingId: string }) => {
      const targetId = String(data.buildingId || data);
      towersRef.current = towersRef.current.filter(t => {
        const match = String(t.id) === targetId;
        if (match) {
          for(let i=0; i<15; i++) {
            particlesRef.current.push({
              pos: { ...t.pos },
              vel: { x: (Math.random()-0.5)*10, y: (Math.random()-0.5)*10 },
              life: 1, maxLife: 1, color: t.color, type: 'tower_dust'
            });
          }
        }
        return !match;
      });
    });

    socket.on('remote_gate_toggled', (data: { buildingId: string, isOpen: boolean }) => {
      const gate = towersRef.current.find(t => String(t.id) === String(data.buildingId));
      if (gate) {
        gate.isOpen = data.isOpen;
      }
    });

    socket.on('village_spawned', (data: any) => {
      if (data.village) {
        const exists = gameMapRef.current.villages.find(v => v.id === data.village.id);
        if (!exists) {
          gameMapRef.current.villages.push(data.village);
          createDust(data.village.pos.x, data.village.pos.y, '#fbbf24');
          
          // UI Notification
          particlesRef.current.push({
            pos: { x: data.village.pos.x, y: data.village.pos.y - 100 },
            vel: { x: 0, y: -1 },
            life: 3,
            maxLife: 3,
            color: '#fbbf24',
            type: 'text',
            text: `NEW VILLAGE: ${data.village.name.toUpperCase()}`
          });
        }
      }
    });

    socket.on('remote_tower_fire', (data: any) => {
      const angle = Math.atan2(data.targetY - data.startY, data.targetX - data.startX);
      projectilesRef.current.push({
        id: generateId(),
        ownerId: data.ownerId || 'remote', // Changed from towerId to ownerId based on emit
        pos: { x: data.startX, y: data.startY },
        vel: { x: Math.cos(angle) * PROJECTILE_SPEED, y: Math.sin(angle) * PROJECTILE_SPEED },
        life: 1.0,
        damage: 60, // Real damage matching AoE logic
        color: data.color || '#fbbf24',
        empireId: data.empireId || 'neutral',
        targetPos: { x: data.targetX, y: data.targetY },
        isReal: true
      });
      
      // Visual Smoke Trail Init
      for (let i = 0; i < 5; i++) {
        particlesRef.current.push({
          pos: { x: data.startX, y: data.startY },
          vel: { x: (Math.random()-0.5)*3, y: (Math.random()-0.5)*3 },
          life: 0.8,
          maxLife: 0.8,
          color: 'rgba(255, 200, 50, 0.5)',
          type: 'dust'
        });
      }
    });

    socket.on('player_eliminated', (data: { loserId: string, winnerId?: string, winnerName: string }) => {
      const mySid = socketRef.current?.id || myIdRef.current;
      
      const isItMe = data.loserId === mySid || (myIdRef.current && data.loserId === myIdRef.current);

      if (isItMe) {
        const killer = data.winnerName && data.winnerName !== 'Enemy' ? data.winnerName : getKillerName(data.winnerId || null);
        setMatchResult({ isWinner: false, winnerName: killer });
        setKillerName(killer);
        
        const endTime = Date.now();
        endTimeRef.current = endTime;
        const start = startTimeRef.current || (endTime - 1000);
        const durationSecs = Math.floor((endTime - start) / 1000);
        const mins = Math.floor(durationSecs / 60).toString().padStart(2, '0');
        const secs = (durationSecs % 60).toString().padStart(2, '0');
        
        setMatchStats({
          duration: `${mins}:${secs}`,
          maxArmy: maxArmyRef.current,
          towersBuilt: towersBuiltRef.current,
          kills: killsRef.current
        });
        
        ENGINE_STATE = 'MATCH_RESULTS';
        setGameState('MATCH_RESULTS');
        gameStateRef.current = 'MATCH_RESULTS';
        saveFinalStats(false);
        setIsSpectator(true);
      } else {
        // Someone else died
        recentlyDestroyedPlayers.current.set(data.loserId, Date.now()); // Tombstone the player
        remotePlayersRef.current.delete(data.loserId);
        entitiesRef.current = entitiesRef.current.filter(e => e.id !== data.loserId);
        
        // CHECK: If we are the ONLY ONE left after this elimination, we WIN.
        const alivePlayers = entitiesRef.current.filter(e => e.type === 'player' && e.units.length > 0);
        const mySidVal = socketRef.current?.id || myId;
        const amIAlive = entitiesRef.current.find(e => e.id === mySidVal && e.units.length > 0);

        if (alivePlayers.length === 1 && amIAlive && !isSpectatorRef.current) {
            setMatchResult({ isWinner: true, winnerName: nickname || 'You' });
            
            const endTime = Date.now();
            endTimeRef.current = endTime;
            const start = startTimeRef.current || (endTime - 1000);
            const durationSecs = Math.floor((endTime - start) / 1000);
            const mins = Math.floor(durationSecs / 60).toString().padStart(2, '0');
            const secs = (durationSecs % 60).toString().padStart(2, '0');
            
            setMatchStats({
              duration: `${mins}:${secs}`,
              maxArmy: maxArmyRef.current,
              towersBuilt: towersBuiltRef.current,
              kills: killsRef.current
            });
            
            ENGINE_STATE = 'MATCH_RESULTS';
            setGameState('MATCH_RESULTS');
            gameStateRef.current = 'MATCH_RESULTS';
            saveFinalStats(true);
            setIsSpectator(true);
        }
      }
    });

    socket.on('game_over_final', (data: { winnerId: string, winnerName: string }) => {
      const mySid = socketRef.current?.id || myIdRef.current;
      
      // If the server says we won, OR if we are the only one left and the winner is null (Draw fallback)
      const isWinner = data.winnerId === mySid || (myIdRef.current && data.winnerId === myIdRef.current) || (data.winnerId === null && !isSpectatorRef.current);
      
      // Force trigger match results if we are the winner or we are somehow still active
      if (isWinner || gameStateRef.current === 'GAME_ACTIVE') {
        setMatchResult({ isWinner, winnerName: isWinner ? (nickname || 'You') : (data.winnerName || 'Unknown Commander') });
        
        const endTime = Date.now();
        endTimeRef.current = endTime;
        const start = startTimeRef.current || (endTime - 1000);
        const durationSecs = Math.floor((endTime - start) / 1000);
        const mins = Math.floor(durationSecs / 60).toString().padStart(2, '0');
        const secs = (durationSecs % 60).toString().padStart(2, '0');
        
        setMatchStats({
          duration: `${mins}:${secs}`,
          maxArmy: maxArmyRef.current,
          towersBuilt: towersBuiltRef.current,
          kills: killsRef.current
        });
        
        ENGINE_STATE = 'MATCH_RESULTS';
        setGameState('MATCH_RESULTS');
        gameStateRef.current = 'MATCH_RESULTS';
        saveFinalStats(isWinner);
        setIsSpectator(true);
      }
    });

    socket.on('room_update', (room: Room) => {
      if (isLeavingRef.current) return;

      setLastEvent('room_update');
      setCurrentRoom(room);
      currentRoomRef.current = room; // Sync ref immediately
      
      const hostFlag = room.hostId === socket.id;
      if (hostFlag !== isHostRef.current) {
        setIsHost(hostFlag);
        isHostRef.current = hostFlag;
        
        // UI Notification if leadership changed
        if (hostFlag && ENGINE_STATE === 'LOBBY_WAITING') {
          particlesRef.current.push({
            pos: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
            vel: { x: 0, y: -2 },
            life: 3, maxLife: 3, color: '#fbbf24', type: 'text',
            text: 'YOU ARE NOW THE HOST!'
          });
        }
      }
      
      const players = room.players || [];
      setLobbyPlayers(players);
      syncRemotePlayers(players);
      syncRoomStructures(room);
      
      // Only set initial leaderboard in lobby mode. In game, the update loop handles it.
      if (ENGINE_STATE === 'LOBBY_WAITING' && room.players) {
        setLeaderboard(room.players.map(p => ({ name: p.name, score: 0 })));
      }
      
      if (ENGINE_STATE === 'CONNECTING' || (ENGINE_STATE === 'MENU' && isJoiningRoom)) {
        ENGINE_STATE = 'LOBBY_WAITING';
        setGameState('LOBBY_WAITING');
        gameStateRef.current = 'LOBBY_WAITING';
        setIsMultiplayer(true);
        startLobbyArena(players);
        syncRoomStructures(room);
        setIsJoiningRoom(false);
      } else if (ENGINE_STATE === 'LOBBY_WAITING') {
        startLobbyArena(players);
        syncRoomStructures(room);
      }
    });

    socket.on('remote_building_placed', (data: any) => {
      const nextTower = buildTowerFromServerData(data);
      if (!nextTower) return;

      const towerId = String(nextTower.id);
      const existingIdx = towersRef.current.findIndex((tower) => String(tower.id) === towerId);
      if (existingIdx !== -1) {
        towersRef.current[existingIdx] = nextTower;
      } else {
        towersRef.current.push(nextTower);
      }
    });

    socket.on('garrison_destroyed', (data: { garrisonId: string, ownerId: string }) => {
      // Remove it from everyone's screen
      const gid = data.garrisonId;
      recentlyDestroyedGarrisons.current.set(gid, Date.now());
      garrisonsRef.current = garrisonsRef.current.filter(g => g.id !== gid);
      
      // If it's my garrison, update UI and sync
      if (data.ownerId === myId || data.ownerId === socket.id) {
          setPlayerGarrisons([...garrisonsRef.current.filter(gs => gs.ownerId === myId)]);
          
          // Broadcast to make SURE it's gone for everyone else (in case they missed the first event)
          socket.emit('sync_data', {
              roomId: currentRoomRef.current?.id,
              garrisons: garrisonsRef.current.filter(gs => gs.ownerId === myId).map(gs => ({
                  id: gs.id,
                  pos: gs.pos,
                  mode: gs.mode,
                  unitCount: gs.units.length,
                  empireId: gs.empireId,
                  color: gs.color,
                  attackTimer: gs.attackTimer
              }))
          });
      }
    });
    
    socket.on('remote_garrison_hit', (data: any) => {
        const g = garrisonsRef.current.find(g => g.id === data.garrisonId);
        
        // Only apply damage if I AM THE OWNER of this garrison
        if (g && g.ownerId === myId && g.units.length > 0) {
            // Damage cooldown for target
            const now = Date.now();
            if (now - (g.lastDamageTime || 0) < 150) return; 
            g.lastDamageTime = now;

            const damage = data.damage || 34;
            if (data.isFatal || damage >= 1000) {
                g.units = [];
            } else {
                // Apply damage to the first unit
                g.units[0].hp -= damage;
                if (g.units[0].hp <= 0) {
                    g.units.splice(0, 1);
                }
            }
            createDust(g.pos.x, g.pos.y, g.color);
            
            if (g.units.length === 0) {
               garrisonsRef.current = garrisonsRef.current.filter(gs => gs.id !== g.id);
               recentlyDestroyedGarrisons.current.set(g.id, Date.now());
               socket.emit('garrison_destroyed', { roomId: currentRoomRef.current?.id, garrisonId: g.id, ownerId: myId });
            }
            setPlayerGarrisons([...garrisonsRef.current.filter(gs => gs.ownerId === myId)]);
        }
    });

    socket.on('take_unit_damage', (data: any) => {
      // Ignore damage from "ghosts" (entities we already killed locally)
      if (data.attackerId && recentlyDestroyedPlayers.current.has(data.attackerId)) {
          return;
      }
      if (data.attackerGarrisonId && recentlyDestroyedGarrisons.current.has(data.attackerGarrisonId)) {
          return;
      }

      // NEW: Underground units take no damage from surface attacks
      const p = playerRef.current;
      if (p && p.isUnderground && !data.isUndergroundAttack) return;

      if (data.garrisonId) {
          const g = garrisonsRef.current.find(g => g.id === data.garrisonId);
          if (g && g.ownerId === myId && g.units.length > 0) {
              const damage = data.damage || 34;
              if (data.isFatal || damage >= 1000) {
                  g.units = [];
              } else {
                  g.units[0].hp -= damage;
                  if (g.units[0].hp <= 0) {
                      g.units.splice(0, 1);
                  }
              }
              createDust(g.pos.x, g.pos.y, g.color);
              
              if (g.units.length === 0) {
                 garrisonsRef.current = garrisonsRef.current.filter(gs => gs.id !== g.id);
                 recentlyDestroyedGarrisons.current.set(g.id, Date.now());
                 socket.emit('garrison_destroyed', { roomId: currentRoomRef.current?.id, garrisonId: g.id, ownerId: myId });
              }
              setPlayerGarrisons([...garrisonsRef.current.filter(gs => gs.ownerId === myId)]);
          }
      } else {
          const isMe = data.targetPlayerId === socket.id || data.targetPlayerId === myId;
          if (!isMe) return;

          const p = playerRef.current;
          if (p && p.units.length > 0) {
            // VERIFY DISTANCE ON VICTIM SIDE (Prevent lag-hits from afar)
            // If the attacker is another player or AI, we check if they are actually close enough on OUR screen.
            if (data.attackerId && data.attackerId !== myId) {
                let attackerPos: Vector | null = null;
                
                if (data.attackerGarrisonId) {
                    const g = garrisonsRef.current.find(gr => gr.id === data.attackerGarrisonId);
                    if (g) attackerPos = g.pos;
                } else {
                    const ent = entitiesRef.current.find(e => e.id === data.attackerId);
                    if (ent && ent.units.length > 0) attackerPos = ent.units[0].pos;
                }
                
                if (attackerPos) {
                    const dist = getDistance(p.units[0].pos, attackerPos);
                    // Maximum engagement range is ~60px + unit radius. 
                    // Allow some buffer (e.g., 180px) for high-speed dashes and network jitter.
                    if (dist > 180) {
                        return; // Discard damage if attacker is too far on our screen
                    }
                }
            }

            // The attacker is the authority for melee hits to ensure "what you see is what you hit".
            
            // If no specific unit index is provided, target the LAST unit (non-commander) first.
            // This prevents instant commander death when the army is still large.
            let idx = data.unitIndex;
            if (idx === undefined) {
                idx = p.units.length - 1; // Target the tail of the swarm
            }
            
            const targetUnit = p.units[idx];
            if (targetUnit) {
                const authoritativeSoldierCount = typeof data.currentUnitCount === 'number'
                  ? Math.max(0, Math.floor(data.currentUnitCount))
                  : Math.max(0, p.units.length - 1);
                const authoritativeTotalUnits = Math.max(1, authoritativeSoldierCount + 1);
                const authoritativeHp = typeof data.currentHp === 'number'
                  ? data.currentHp
                  : (p.units[0]?.hp || COMMANDER_MAX_HP);

                while (p.units.length > authoritativeTotalUnits) {
                  p.units.pop();
                }
                while (p.units.length < authoritativeTotalUnits && p.units[0]) {
                  p.units.push({
                    id: generateId('u'),
                    pos: { ...p.units[0].pos },
                    color: p.color,
                    type: 'infantry',
                    hp: 100
                  });
                }

                if (p.units[0]) {
                  p.units[0].hp = authoritativeHp;
                  createDust(p.units[0].pos.x, p.units[0].pos.y, p.color);
                }
                p.lastKnownUnitCount = authoritativeSoldierCount;
                setScore(Math.max(0, p.units.length - 1));
            }
          }
      }
    });

    socket.on('remote_hp_sync', (data: { id: string, hp: number }) => {
      if (!data?.id) return;
      const localId = socket.id || myIdRef.current;
      if (data.id === localId) return;

      const target = remotePlayersRef.current.get(data.id) || entitiesRef.current.find(e => e.id === data.id);
      if (target?.units[0]) {
        target.units[0].hp = data.hp;
      }
    });

    socket.on('start_countdown', (seconds: number) => {
      setLastEvent('start_countdown');
      let ticks = seconds;
      setCountdown(ticks);
      
      const timer = setInterval(() => {
        ticks -= 1;
        setCountdown(ticks);
        
        if (ticks <= 0) {
          clearInterval(timer);
          // Transition to active game
          
          startTimeRef.current = Date.now();
          towersBuiltRef.current = 0;
          maxArmyRef.current = 1;
          killsRef.current = 0;
          setMatchResult(null);
          setIsSpectator(false);
          
          ENGINE_STATE = 'GAME_ACTIVE';
          setGameState('GAME_ACTIVE');
          gameStateRef.current = 'GAME_ACTIVE';
          setCountdown(null);
          
          worldSizeRef.current = WORLD_SIZE;
          if (currentRoomRef.current) {
              const roomSeed = currentRoomRef.current.id.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
              const players: Entity[] = (lobbyPlayersRef.current || []).map(lp => ({
                id: lp.id,
                name: lp.name,
                type: 'player',
                units: [{ id: generateId(), pos: { x: WORLD_SIZE/2, y: WORLD_SIZE/2 }, color: lp.id === myId ? playerColor : '#94a3b8', type: 'infantry', hp: 500 }],
                color: lp.id === myId ? playerColor : '#94a3b8',
                faction: lp.id === myId ? playerColor : '#94a3b8',
                empireId: lp.id === myId ? initialEmpire.id : (lp.empireId || 'neutral'),
                score: 1,
                akce: 0,
                isDashing: false,
                velocity: {x:0, y:0},
                facingAngle: 0,
                isAttacking: false,
                attackTimer: 0,
                attackCooldown: 0,
                weightSlowdown: 0,
                splitCooldown: 0
              }));
              initGame(roomSeed, players);
          }
        }
      }, 1000);
    });

    socket.on('update_rematch_votes', (data) => {
      setVoteCount({ voted: data.votedPlayers, total: data.maxPlayers });
    });

    socket.on('rematch_started', (roomData) => {
      setVoteCount({ voted: 0, total: 0 }); 
      setHasVoted(false);
      setCurrentRoom(roomData); 
      currentRoomRef.current = roomData;
      setIsSpectator(false);
      setCameraZoom(1);
      
      setGameState('LOBBY_WAITING');
      ENGINE_STATE = 'LOBBY_WAITING'; 
      gameStateRef.current = 'LOBBY_WAITING';
      startLobbyArena(roomData.players || []);
      syncRoomStructures(roomData);
    });

    socket.on('remote_tunnel_update', (data: any) => {
      const nextTunnel = buildTunnelFromServerData(data);
      if (!nextTunnel) return;

      const tunnelId = String(nextTunnel.id);
      const existingIdx = tunnelsRef.current.findIndex((tunnel) => String(tunnel.id) === tunnelId);
      if (existingIdx !== -1) {
        tunnelsRef.current[existingIdx] = nextTunnel;
      } else {
        tunnelsRef.current.push(nextTunnel);
      }

      const tunnelTower = buildTowerFromServerData({ ...data, type: 'tunnel' });
      if (!tunnelTower) return;
      const towerIdx = towersRef.current.findIndex((tower) => String(tower.id) === tunnelId);
      if (towerIdx !== -1) {
        towersRef.current[towerIdx] = tunnelTower;
      } else {
        towersRef.current.push(tunnelTower);
      }
    });

    socket.on('remote_tunnel_remove', (data: { id: string }) => {
      const tunnelId = String(data.id);
      tunnelsRef.current = tunnelsRef.current.filter((tunnel) => String(tunnel.id) !== tunnelId);
      towersRef.current = towersRef.current.filter((tower) => String(tower.id) !== tunnelId);
    });

    socket.on('sync_tunnels', (data: { tunnels: TunnelEntrance[] }) => {
      if (data.tunnels && Array.isArray(data.tunnels)) {
        syncRoomStructures({ tunnels: data.tunnels, buildings: towersRef.current.filter((tower) => tower.type !== 'tunnel') } as Room);
      }
    });

    socket.on('match_started', (data: { seed: number, players: Entity[] }) => {
      setLastEvent('match_started');
      setIsSpectator(false);
      startTimeRef.current = Date.now();
      ENGINE_STATE = 'GAME_ACTIVE';
      setGameState('GAME_ACTIVE');
      gameStateRef.current = 'GAME_ACTIVE';
      const gameSeed = data?.seed || 0.5;
      initGame(gameSeed, data.players);
      syncRoomStructures(data as unknown as Room);
    });

    socket.on('split_result', (data: { success?: boolean, splitCount?: number, remainingUnitCount?: number, mode?: 'HOLD' | 'HUNT' | 'RECALL', strategy?: 'HALF' | 'SEPARATE_ALL' }) => {
      if (!data?.success || !playerRef.current) return;

      const player = playerRef.current;
      const currentUnits = player.units.length;
      const desiredRemaining = Math.max(1, Math.floor((data.remainingUnitCount ?? Math.max(0, currentUnits - 1)) + 1));
      const splitCount = typeof data.splitCount === 'number'
        ? data.splitCount
        : Math.max(0, currentUnits - desiredRemaining);

      const createdId = createSplitGarrison(player, splitCount, data.mode || 'HOLD');
      while (player.units.length > desiredRemaining) {
        player.units.pop();
      }
      while (player.units.length < desiredRemaining && player.units[0]) {
        player.units.push({
          id: generateId('u'),
          pos: { ...player.units[0].pos },
          color: player.color,
          type: 'infantry',
          hp: 100
        });
      }

      if (createdId && data.mode) {
        const garrison = garrisonsRef.current.find((item) => item.id === createdId);
        if (garrison) garrison.mode = data.mode;
      }
    });

    socket.on('remote_update', (data: any) => {
      if (!data || !data.id) return;

      const pid = String(data.id);
      const isItMe = pid === socket.id || pid === myId;

      if (isItMe) return;

      // FIXED: Block updates for players who were recently killed locally
      if (recentlyDestroyedPlayers.current.has(pid)) {
        const timeSinceDeath = Date.now() - (recentlyDestroyedPlayers.current.get(pid) || 0);
        if (timeSinceDeath < 10000) return; 
        else recentlyDestroyedPlayers.current.delete(pid);
      }

      if (data.isLeaving) {
        entitiesRef.current = entitiesRef.current.filter(e => e.id !== pid);
        remotePlayersRef.current.delete(pid);
        setLobbyPlayers(prev => {
            const next = prev.filter(p => p.id !== pid);
            lobbyPlayersRef.current = next;
            return next;
        });
        return;
      }

      let idx = entitiesRef.current.findIndex(e => e.id === pid);
      
      const realPos: Vector = {
        x: typeof data.x === 'number' ? data.x : 0,
        y: typeof data.y === 'number' ? data.y : 0
      };
      const realAngle: number = typeof data.rotation === 'number' ? data.rotation : 0;

      if (idx !== -1) {
        const ent = entitiesRef.current[idx];
        const head = ent.units[0];
        if (head) {
          const shouldSnapToRemotePos =
            !ent.lastUpdate ||
            !ent.targetPos ||
            getDistance(head.pos, realPos) > 500;

          if (shouldSnapToRemotePos) {
            head.pos = { ...realPos };
          }
        }

        ent.targetAngle = realAngle; 
        ent.targetPos = { ...realPos }; 
        ent.lastPos = { ...realPos };
        ent.lastUpdate = Date.now(); 
        ent.akce = data.akce;
        ent.name = data.name || ent.name; 
        remotePlayersRef.current.set(pid, ent);
        
        if (data.empireId || data.faction || data.name) {
          const currentEmpire = data.empireId || ent.empireId;
          const currentFaction = data.faction || ent.color;
          const currentName = data.name || ent.name;
          
          if (pid) {
            playerSkinsRef.current.set(pid, { 
              empireId: currentEmpire as EmpireType, 
              faction: currentFaction,
              name: currentName
            });
          }

          if (data.empireId) ent.empireId = data.empireId;
          if (data.name) ent.name = data.name;
          if (data.faction) {
            ent.color = data.faction;
            if (ent.units[0]) ent.units[0].color = data.faction;
          }
        }
        
        // Fix: Reliable empireId synchronization fallback
        if (!ent.empireId || ent.empireId === 'neutral') {
          // Heuristic fallback if sync packet missed empireId
          if (data.faction === '#991b1b') ent.empireId = 'tim';
          else if (data.faction === '#1e3a8a') ent.empireId = 'rim';
          else if (data.faction === '#1e40af') ent.empireId = 'fim';
          
          if (ent.empireId !== 'neutral' && pid) {
            playerSkinsRef.current.set(pid, { 
              empireId: ent.empireId as EmpireType, 
              faction: ent.color 
            });
          }
        }

        const remoteSoldierCount = typeof data.unitCount === 'number' ? Math.max(0, Math.floor(data.unitCount)) : Math.max(0, ent.units.length - 1);
        ent.score = remoteSoldierCount;
        ent.isDashing = data.isDashing;
        ent.isAttacking = data.isAttacking;
        ent.isUnderground = data.isUnderground ?? false; 
        if (data.equippedItem) ent.equippedItem = data.equippedItem; // NEW
        
        if (ent.units.length > 0) {
        ent.units[0].hp = typeof data.hp === 'number' ? data.hp : COMMANDER_MAX_HP;
          
          if (data.recruitedIds && Array.isArray(data.recruitedIds)) {
            data.recruitedIds.forEach((rid: string) => {
              neutralsRef.current = neutralsRef.current.filter(n => n.id !== rid);
            });
          }
          
          if (data.unitCount !== undefined) {
            const desiredSoldierCount = Math.max(0, Math.floor(data.unitCount));
            const desiredTotalCount = desiredSoldierCount + 1;
            const currentCount = ent.units.length;
            
            if (desiredTotalCount > currentCount) {
              const timeSinceKill = Date.now() - (ent.lastDamageTime || 0);
              if (timeSinceKill > 2000) { 
                  const diff = desiredTotalCount - currentCount;
                  for (let i = 0; i < diff; i++) {
                    ent.units.push({ id: generateId('u'), pos: { ...realPos }, color: ent.color, type: 'infantry', hp: 100 });
                  }
              }
            } else if (desiredTotalCount < currentCount) {
              ent.units = ent.units.slice(0, desiredTotalCount);
            }
            ent.lastKnownUnitCount = desiredSoldierCount;
          }
        }
        
        if (data.garrisons && Array.isArray(data.garrisons)) {
          data.garrisons.forEach((rg: any) => {
            const existing = garrisonsRef.current.find(g => g.id === rg.id && g.ownerId === pid);
            if (existing) {
              existing.lastSyncPos = { ...rg.pos };
              existing.lastUpdate = Date.now(); 
              existing.mode = rg.mode;
              existing.targetPos = rg.targetPos; 
              existing.attackTimer = rg.attackTimer || 0;
              existing.isUnderground = rg.isUnderground ?? false; // NEW: Sync layer
              
              const currentGCount = existing.units.length;
              if (existing.lastKnownUnitCount === undefined) existing.lastKnownUnitCount = currentGCount;
              const maxSeen = existing.lastKnownUnitCount;
              
              const isTombstoned = recentlyDestroyedGarrisons.current.has(existing.id);
              
              if (!isTombstoned) {
                  if (rg.unitCount > maxSeen) {
                      const realNewUnits = rg.unitCount - maxSeen;
                      for (let i = 0; i < realNewUnits; i++) {
                          existing.units.push({ id: generateId('ru'), pos: existing.pos, color: rg.color, type: 'infantry', hp: 100 });
                      }
                      existing.lastKnownUnitCount = rg.unitCount;
                  } else if (rg.unitCount < maxSeen) {
                      if (rg.unitCount < currentGCount) {
                          existing.units = existing.units.slice(0, rg.unitCount);
                      }
                      existing.lastKnownUnitCount = rg.unitCount;
                  }
              }
            } else {
              const tombstone = recentlyDestroyedGarrisons.current.get(rg.id);
              if (tombstone) {
                  const timeSinceDeath = Date.now() - tombstone;
                  if (timeSinceDeath < 20000) return; 
                  else recentlyDestroyedGarrisons.current.delete(rg.id);
              }

              const newGarrison: Garrison = {
                id: rg.id || generateId('rg'),
                ownerId: pid,
                pos: { ...rg.pos },
                lastSyncPos: { ...rg.pos },
                lastKnownUnitCount: rg.unitCount, 
                mode: rg.mode,
                units: Array(rg.unitCount).fill(0).map((_, i) => {
                    const row = Math.floor(i / 4), col = i % 4; 
                    const ox = (col - 1.5) * 35, oy = (row + 1) * 35;
                    return {
                        id: generateId('ru'), 
                        pos: { x: rg.pos.x + ox, y: rg.pos.y + oy }, 
                        color: rg.color, 
                        type: 'infantry', 
                        hp: 100
                    };
                }),
                color: rg.color,
                empireId: rg.empireId,
                attackTimer: rg.attackTimer || 0,
                attackCooldown: 0,
                targetPos: rg.targetPos || rg.pos,
                justSplit: false,
                isLocal: false,
                isUnderground: rg.isUnderground ?? false // NEW: Sync layer
              };
              garrisonsRef.current.push(newGarrison);
            }
          });

          const updatedIds = new Set(data.garrisons.map((rg: any) => rg.id));
          garrisonsRef.current = garrisonsRef.current.filter(g => {
            if (g.ownerId !== pid || g.isLocal) return true; 
            
            if (!updatedIds.has(g.id)) {
                return false; 
            }
            
            if (recentlyDestroyedGarrisons.current.has(g.id)) {
                return false;
            }
            
            return true;
          });
        }

        if (isHostRef.current && data.caravanEscortRequest) {
            const c = caravansRef.current.find(c => c.id === data.caravanEscortRequest);
            if (c && !c.escortOwnerId) {
                c.escortOwnerId = pid;
                c.escortTimer = 5;
                c.lastAkceTime = Date.now();
                c.outOfCircleTime = 0;
            }
        }

        if (data.caravans && Array.isArray(data.caravans)) {
          data.caravans.forEach((rc: any) => {
            const existing = caravansRef.current.find(c => c.id === rc.id);
            if (existing) {
              existing.lastSyncPos = { ...rc.pos };
              existing.targetPos = { ...rc.targetPos };
              existing.escortOwnerId = rc.escortOwnerId;
              
              const sid = socketRef.current?.id || myIdRef.current;
              if (existing.escortOwnerId !== sid) {
                  existing.escortTimer = rc.escortTimer;
              }
              
              existing.outOfCircleTime = rc.outOfCircleTime;
            } else {
              caravansRef.current.push({
                id: rc.id,
                pos: { ...rc.pos },
                lastSyncPos: { ...rc.pos },
                targetPos: { ...rc.targetPos },
                speed: 1.0,
                color: '#fbbf24',
                escortOwnerId: rc.escortOwnerId,
                escortTimer: rc.escortTimer,
                outOfCircleTime: rc.outOfCircleTime
              });
            }
          });
          // Cleanup old caravans
          const currentIds = new Set(data.caravans.map((rc: any) => rc.id));
          caravansRef.current = caravansRef.current.filter(c => currentIds.has(c.id));
        }
      } else {
        // Only re-create if the player is still in the room
        if (recentlyDestroyedPlayers.current.has(pid)) return; // CRITICAL: Prevent Player resurrection

        const isInRoom = lobbyPlayersRef.current.some(p => String(p.id) === pid);
        if (!isInRoom) {
          // If they aren't in the room list, they should NOT be in entitiesRef or remotePlayersRef either
          if (remotePlayersRef.current.has(pid)) {
            remotePlayersRef.current.delete(pid);
            entitiesRef.current = entitiesRef.current.filter(e => e.id !== pid);
          }
          return;
        }

        const cached = playerSkinsRef.current.get(pid);
        const factionColor = data.faction || cached?.faction || '#94a3b8';
        const empireId = data.empireId || cached?.empireId || 'neutral';

        const newPlayer: Entity = {
          id: pid,
          name: data.name || `Commander #${pid.slice(0, 3)}`,
          type: 'player',
          units: [{ id: generateId('c'), pos: { ...realPos }, color: factionColor, type: 'infantry', hp: typeof data.hp === 'number' ? data.hp : COMMANDER_MAX_HP }],
          color: factionColor, 
          faction: factionColor,
          empireId: empireId,
          score: typeof data.unitCount === 'number' ? Math.max(0, Math.floor(data.unitCount)) : 0,
          akce: data.akce || 0,
          lastKnownUnitCount: typeof data.unitCount === 'number' ? Math.max(0, Math.floor(data.unitCount)) : 0,
          isDashing: data.isDashing || false,
          velocity: { x: 0, y: 0 },
          facingAngle: realAngle,
          isAttacking: data.isAttacking || false,
          attackTimer: 0,
          attackCooldown: 0,
          weightSlowdown: 0,
          splitCooldown: 0,
          targetPos: { ...realPos },
          targetAngle: realAngle,
          lastUpdate: Date.now(),
          lastPos: { ...realPos }
        };
        
        // Save to cache for future use
        if (empireId !== 'neutral') {
          playerSkinsRef.current.set(pid, { empireId: empireId as EmpireType, faction: factionColor });
        }

        // Fill initial units based on count
        const initialSoldierCount = typeof data.unitCount === 'number' ? Math.max(0, Math.floor(data.unitCount)) : 0;
        if (initialSoldierCount > 0) {
          for (let i = 0; i < initialSoldierCount; i++) {
            newPlayer.units.push({ id: generateId('u'), pos: { ...realPos }, color: newPlayer.color, type: 'infantry', hp: 100 });
          }
        }
        remotePlayersRef.current.set(pid, newPlayer);
        entitiesRef.current.push(newPlayer);
      }
    });

    socket.on('attack_event', (data: { id: string }) => {
      const ent = entitiesRef.current.find(e => e.id === data.id);
      if (ent) {
        ent.isAttacking = true;
        ent.attackTimer = 300;
        ent.attackCooldown = 500;
        ent.swingKills = 0; // Reset swing kills for remote players
      }
    });

    socket.on('sync_world', (data: { neutrals: Unit[], towers: Tower[] }) => {
      if (!isHost) {
        neutralsRef.current = data.neutrals;
      }
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('set_id');
      socket.off('connect_error');
      socket.off('room_list');
      socket.off('join_success');
      socket.off('remote_building_destroyed');
      socket.off('remote_building_hit');
      socket.off('remote_gate_toggled');
      socket.off('remote_tower_fire');
      socket.off('remote_building_placed');
      socket.off('take_unit_damage');
      socket.off('remote_hp_sync');
      socket.off('room_update');
      socket.off('start_countdown');
      socket.off('match_started');
      socket.off('split_result');
      socket.off('update_rematch_votes');
      socket.off('rematch_started');
      socket.off('remote_garrison_hit');
      socket.off('garrison_destroyed');
      socket.off('player_eliminated');
      socket.off('game_over_final');
      socket.off('remote_tunnel_update');
      socket.off('remote_tunnel_remove');
      socket.off('sync_tunnels');
      socket.off('attack_event');
      socket.off('sync_world');
      socket.off('server_capacity');
      socket.off('queue_update');
      socket.off('queue_approved');
      socket.off('village_spawned');
      socket.off('error');
      socket.disconnect();
    };
  }, []);

  // Throttled Network Sync moved to update loop for performance and logic consistency
  useEffect(() => {
    // This effect now only handles periodic world sync if host
    if (gameState === 'GAME_ACTIVE' && isMultiplayer && isHost && currentRoom) {
      const interval = setInterval(() => {
        if (socketRef.current && currentRoom) {
          socketRef.current.emit('host_sync_world', {
            roomId: currentRoom.id,
            neutrals: neutralsRef.current
          });
        }
      }, 1000); // World sync can be much slower (1Hz)
      return () => clearInterval(interval);
    }
  }, [gameState, isMultiplayer, isHost, currentRoom]);

  const getEmpireCurrency = (eid?: string) => {
    const empireId = eid || playerRef.current?.empireId || initialEmpire.id;
    return EMPIRE_CURRENCIES[empireId] || 'Akce';
  };

  const startLobby = () => {
    if (!roomForm.name.trim() || !nickname.trim() || !socketRef.current) return;
    setIsCreatingRoom(true);
    setIsMultiplayer(true);
    setGameState('LOBBY_WAITING');
    ENGINE_STATE = 'LOBBY_WAITING';
    socketRef.current.emit('create_room', {
      name: roomForm.name,
      password: roomForm.password,
      limit: roomForm.limit,
      playerName: nickname // Send player name during creation
    });
  };

  const joinRoom = (room: Room) => {
    if (!socketRef.current) return;
    
    // If room has a password, show our custom modal instead of prompt
    if (room.password) {
      setPasswordModalRoom(room);
      setPasswordInput('');
      return;
    }
    
    submitJoinRequest(room.id, '');
  };

  const submitJoinRequest = (roomId: string | number, password: string) => {
    if (!socketRef.current) return;
    
    setIsJoiningRoom(true);
    setIsMultiplayer(true);
    setGameState('CONNECTING');
    ENGINE_STATE = 'CONNECTING';
    
    socketRef.current.emit('join_room', { 
      roomId: String(roomId), 
      password: password || '',
      playerName: nickname // Send player name during join
    });
    
    setPasswordModalRoom(null); // Close modal if it was open
  };

  useEffect(() => {
    if (currentRoom && socketRef.current) {
        const hostFlag = currentRoom.hostId === socketRef.current.id;
        if (hostFlag !== isHost) {
            setIsHost(hostFlag);
            isHostRef.current = hostFlag;
        }
    }
  }, [currentRoom, isHost]);

  const leaveRoom = () => {
    if (socketRef.current && currentRoom) {
      isLeavingRef.current = true;
      
      // Standard leave logic
      socketRef.current.emit('leave_room', String(currentRoom.id));
      
      // Clear flag after a delay to allow future joins
      setTimeout(() => {
        isLeavingRef.current = false;
      }, 1000);
    }
    
    // Immediate local cleanup to stop sync_data loop
    ENGINE_STATE = 'MENU';
    gameStateRef.current = 'MENU';
    setIsMultiplayer(false);
    
    entitiesRef.current = [];
    towersRef.current = [];
    projectilesRef.current = [];
    particlesRef.current = [];
    garrisonsRef.current = [];
    neutralsRef.current = [];
    
    setGameState('MENU');
    setIsHost(false);
    setCurrentRoom(null);
    setIsSpectator(false);
    setCameraZoom(1);
    setPlayerGarrisons([]);
  };

  const voteRematch = () => {
    if (!socketRef.current || !currentRoom) return;
    // Rematch vote emit
    socketRef.current.emit('vote_rematch', currentRoom.id);
    setHasVoted(true);
  };

  const showError = (msg: string) => {
    setErrorMessage(msg);
    setTimeout(() => setErrorMessage(null), 3000);
  };



  const purchaseUnit = useCallback((ent: Entity, type: UnitType) => {
    const price = UNIT_PRICES[type as keyof typeof UNIT_PRICES];
    if (ent.akce >= price) {
      if (ent.id === myId) {
        if (type === 'wall') { setIsPlacingWall(true); setIsPlacingGate(false); setIsPlacingTower(false); setShowShop(false); return; }
        if (type === 'gate') { setIsPlacingGate(true); setIsPlacingWall(false); setIsPlacingTower(false); setShowShop(false); return; }
        if (type === 'tower') { setIsPlacingTower(true); setIsPlacingWall(false); setIsPlacingGate(false); setShowShop(false); return; }
      }
      
      const head = ent.units[0];
      if (head) {
        // AI or non-manual logic (if any left)
        if (type === 'tower' || type === 'wall' || type === 'gate') {
          // ... rest of AI building logic if needed ...
        } else {
          ent.akce -= price;
          ent.units.push({
            id: generateId(),
            color: ent.color,
            pos: { x: head.pos.x + (Math.random() - 0.5) * 40, y: head.pos.y + (Math.random() - 0.5) * 40 },
            type: type as 'infantry' | 'archer',
            hp: 100
          });
        }
      }
      if (ent.id === myId) setPlayerAkce(ent.akce);
    }
  }, [myId]);

  const splitSwarm = useCallback((ent: Entity, forceExecute: boolean = false) => {
    if (ent.units.length < 15) {
      if (ent.id === myId) {
        showError(t.notEnoughUnitsForSplit);
      }
      return;
    }
    
    if (ent.id === myId && !activeSplitGarrisonId && !forceExecute) {
      setActiveSplitGarrisonId('pending_split');
      return;
    }

    let autoHunt = false;
    entitiesRef.current.forEach((entity) => {
      if (entity.id !== ent.id && entity.units.length > 0 && getDistance(ent.units[0].pos, entity.units[0].pos) < 300) {
        autoHunt = true;
      }
    });

    const targetMode = autoHunt ? 'HUNT' : 'HOLD';

    if (ent.id === myId && isMultiplayer && currentRoomRef.current && socketRef.current) {
      socketRef.current.emit('request_split', {
        roomId: currentRoomRef.current.id,
        mode: targetMode,
        strategy: 'HALF'
      });
      return null;
    }

    return createSplitGarrison(ent, Math.floor(ent.units.length / 2), targetMode);
  }, [myId, activeSplitGarrisonId, isMultiplayer, createSplitGarrison, t.notEnoughUnitsForSplit]);

  const executeSplit = useCallback((mode: 'HOLD' | 'HUNT' | 'RECALL' | 'SEPARATE_ALL') => {
    if (!playerRef.current) return;
    const p = playerRef.current;
    
    if (mode === 'SEPARATE_ALL') {
      if (p.units.length <= 1) {
        setActiveSplitGarrisonId(null);
        return;
      }

      if (isMultiplayer && currentRoomRef.current && socketRef.current) {
        socketRef.current.emit('request_split', {
          roomId: currentRoomRef.current.id,
          mode: 'HUNT',
          strategy: 'SEPARATE_ALL'
        });
      } else {
        createSplitGarrison(p, p.units.length - 1, 'HUNT');
      }
    } else {
      if (isMultiplayer && currentRoomRef.current && socketRef.current) {
        socketRef.current.emit('request_split', {
          roomId: currentRoomRef.current.id,
          mode,
          strategy: 'HALF'
        });
      } else {
        const gid = createSplitGarrison(p, Math.floor(p.units.length / 2), mode);
        if (gid) {
          const garrison = garrisonsRef.current.find((g) => g.id === gid);
          if (garrison) garrison.mode = mode;
        }
      }
    }
    setActiveSplitGarrisonId(null);
   }, [isMultiplayer, createSplitGarrison]);
 
   const dismissUnits = useCallback((ent: Entity, count: number | 'ALL') => {
     if (ent.units.length <= 1) return; // Cannot dismiss the Commander
 
     const availableToDismiss = ent.units.length - 1;
     const toRemove = count === 'ALL' ? availableToDismiss : Math.min(count, availableToDismiss);
     
     if (toRemove <= 0) return;
 
     // Remove from the end of the array (not the commander at index 0)
     const removed = ent.units.splice(ent.units.length - toRemove, toRemove);
     
     // Refund: 5 Akçe per unit
     const refund = removed.length * 5;
     ent.akce += refund;
     
     if (ent.id === myId) {
       setPlayerAkce(ent.akce);
       // Small visual feedback? 
       shakeRef.current = 5;
     }
   }, [myId]);
 
    const resolveCollision = (pos: Vector, vel: Vector, obstacles: Obstacle[], towers: Tower[] = []): Vector => {
    let nx = pos.x + vel.x;
    let ny = pos.y + vel.y;
    const padding = 2;

    // Handle Obstacles
    for (const o of obstacles) {
      if (o.type === 'grass') continue;
      
      // Optimization: Skip obstacles that are clearly too far
      const dx_o = nx - o.center.x;
      const dy_o = ny - o.center.y;
      const max_d = o.radius + UNIT_RADIUS + padding + 50;
      if (Math.abs(dx_o) > max_d || Math.abs(dy_o) > max_d) continue;
      
      let collided = false;
      let center = o.center;
      let radius = o.radius;

      if (o.type === 'tree') {
        // Precise rectangular trunk hitbox
        const tw = 12, th = 16;
        const tx = o.center.x - tw, ty = o.center.y - th;
        if (nx + UNIT_RADIUS > tx && nx - UNIT_RADIUS < tx + tw*2 &&
            ny + UNIT_RADIUS > ty && ny - UNIT_RADIUS < ty + th*2) {
          collided = true;
          const dx = nx - o.center.x;
          const dy = ny - o.center.y;
          if (Math.abs(dx)/tw > Math.abs(dy)/th) nx = pos.x;
          else ny = pos.y;
        }
      } else {
        const dist = getDistance({ x: nx, y: ny }, center);
        if (dist < radius + UNIT_RADIUS + padding) collided = true;
      }

      if (collided && o.type !== 'tree') {
        const dx = nx - center.x;
        const dy = ny - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const overlap = (radius + UNIT_RADIUS + padding) - dist;
        if (overlap > 0) { nx += (dx / dist) * overlap; ny += (dy / dist) * overlap; }
        const normalX = dx / dist, normalY = dy / dist;
        const dot = vel.x * normalX + vel.y * normalY;
        if (dot < 0) { vel.x -= dot * normalX; vel.y -= dot * normalY; }
      }
    }

    // Handle Buildings - PURE POSITION DISPLACEMENT (NO DAMAGE)
    for (const t of towers) {
      if (t.type === 'gate' && t.isOpen) continue;
      
      // Optimization: Skip buildings that are clearly too far
      const dx_t = nx - t.pos.x;
      const dy_t = ny - t.pos.y;
      if (Math.abs(dx_t) > 100 || Math.abs(dy_t) > 100) continue;

      if (t.type === 'wall' || t.type === 'gate') {
        const isVertical = t.rotation === 90;
        
        // --- FIXED COLLISION HITBOX (FULL CORNER COVERAGE) ---
        // Using standardized constants for length and thickness
        const wallWidth = isVertical ? WALL_THICKNESS : WALL_LENGTH + 10; // Extra 10px overlap for physical blocking
        const wallHeight = isVertical ? WALL_LENGTH + 10 : WALL_THICKNESS;
        
        const hw = wallWidth / 2;
        const hh = wallHeight / 2;
        
        const minX = t.pos.x - hw - UNIT_RADIUS - padding;
        const maxX = t.pos.x + hw + UNIT_RADIUS + padding;
        const minY = t.pos.y - hh - UNIT_RADIUS - padding;
        const maxY = t.pos.y + hh + UNIT_RADIUS + padding;

        if (nx > minX && nx < maxX && ny > minY && ny < maxY) {
          const dx1 = nx - minX, dx2 = maxX - nx;
          const dy1 = ny - minY, dy2 = maxY - ny;
          const minDist = Math.min(dx1, dx2, dy1, dy2);
          
          if (minDist === dx1) { nx = minX; vel.x = Math.min(0, vel.x); }
          else if (minDist === dx2) { nx = maxX; vel.x = Math.max(0, vel.x); }
          else if (minDist === dy1) { ny = minY; vel.y = Math.min(0, vel.y); }
          else if (minDist === dy2) { ny = maxY; vel.y = Math.max(0, vel.y); }
        }
      } else {
        const bRadius = 35; // Matches visual size for towers
        const dx = nx - t.pos.x;
        const dy = ny - t.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = bRadius + UNIT_RADIUS + padding;

        if (dist < minDist) {
          const overlap = minDist - dist;
          nx += (dx / dist) * overlap;
          ny += (dy / dist) * overlap;
          
          // Tangent slide
          const normalX = dx / dist, normalY = dy / dist;
          const dot = vel.x * normalX + vel.y * normalY;
          if (dot < 0) { vel.x -= dot * normalX; vel.y -= dot * normalY; }
        }
      }
    }

    return { x: nx, y: ny };
  };

  useEffect(() => {
    const keys = keysRef.current; // Use the ref directly
    const hkd = (e: KeyboardEvent) => { keys[e.code] = true; upd(); };
    const hku = (e: KeyboardEvent) => { keys[e.code] = false; upd(); };
    const upd = () => {
      if (isSpectatorRef.current) {
        keyboardDir.current = { x: 0, y: 0 };
        return;
      }
      let x = 0, y = 0;
      if (keys['KeyW'] || keys['ArrowUp']) y -= 1; if (keys['KeyS'] || keys['ArrowDown']) y += 1;
      if (keys['KeyA'] || keys['ArrowLeft']) x -= 1; if (keys['KeyD'] || keys['ArrowRight']) x += 1;
      if (x !== 0 || y !== 0) { const m = Math.sqrt(x*x + y*y); keyboardDir.current = { x: x/m, y: y/m }; }
      else keyboardDir.current = { x: 0, y: 0 };

      if (keys['Space'] && playerRef.current && playerRef.current.attackCooldown <= 0) {
        const p = playerRef.current;
        if (p.equippedItem === 'shovel' || p.equippedItem === 'super_shovel') {
          // Digging mechanic
          if (p.shovelUses && p.shovelUses > 0) {
            p.shovelUses -= 1;
            p.attackTimer = 300;
            p.attackCooldown = 500;
            createDust(p.units[0].pos.x, p.units[0].pos.y, '#78350f'); // Dirt color
            
            if (p.shovelUses <= 0) {
              p.equippedItem = 'sword'; // Break shovel
              p.shovelUses = 0;
            }

            // Create tunnel as a building using flat x,y for server compatibility
            const newTunnelObj = {
              id: generateId('tunnel'),
              type: 'tunnel',
              x: p.units[0].pos.x,
              y: p.units[0].pos.y,
              ownerId: p.id,
              faction: p.color,
              hp: 999999
            };
            
            if (socketRef.current) {
              const currentRoomId = currentRoomRef.current?.id || (window as any).currentRoomId || '';
              socketRef.current.emit('building_placed', { roomId: currentRoomId, ...newTunnelObj });
            }
          }
        } else {
          // Sword Attack
          p.isAttacking = true;
          p.attackTimer = 300;
          p.attackCooldown = 500;
          p.swingKills = 0; // Reset swing kills
          if (socketRef.current && currentRoom) {
            socketRef.current.emit('attack', { roomId: currentRoom.id });
          }
        }
      }

      if (keys['KeyQ'] && playerRef.current) {
        splitSwarm(playerRef.current);
      }

    if (keys['KeyE'] && gameState === 'GAME_ACTIVE') {
      setShowShop(prev => !prev);
      keys['KeyE'] = false; // Prevent multiple toggles
    }

    // Slot selection 1-9
    for (let i = 1; i <= 9; i++) {
      if (keys[`Digit${i}`] && gameState === 'GAME_ACTIVE') {
        const slot = i - 1;
        setActiveSlot(slot);
        
        const p = playerRef.current;
        if (p) {
          if (slot === 0) p.equippedItem = 'sword';
          else if (slot === 1 && p.shovelUses && p.shovelUses > 0) p.equippedItem = (p.shovelUses > 10 || p.shovelUses === 30) ? 'super_shovel' : 'shovel';
          else p.equippedItem = 'sword';
        }
        keys[`Digit${i}`] = false;
      }
    }

    if (keys['KeyC']) {
      if (activeSplitGarrisonId) {
        setActiveSplitGarrisonId(null);
      } else if (playerRef.current) {
        // Only open the panel if we have enough units
        if (playerRef.current.units.length >= 15) {
          setActiveSplitGarrisonId('pending_split');
        } else {
          showError(t.notEnoughUnitsForSplit);
        }
      }
    }
    if (keys['ShiftLeft'] || keys['ShiftRight']) {
      if (playerRef.current) playerRef.current.isDashing = true;
    } else {
      if (playerRef.current) playerRef.current.isDashing = false;
    }
    if (keys['Escape']) {
      setShowShop(false);
      setIsPlacingWall(false);
      setIsPlacingGate(false);
      setIsPlacingTower(false);
      setActiveSplitGarrisonId(null);
      
      // Clear ghost positions
      lastWallPosRef.current = null;
      placementStartPosRef.current = null;
      placementAxisRef.current = null;
    }
    };
    window.addEventListener('keydown', hkd);
    window.addEventListener('keyup', hku);
    return () => {
      window.removeEventListener('keydown', hkd);
      window.removeEventListener('keyup', hku);
    };
  }, [splitSwarm, gameState, currentRoom]); // Added currentRoom to re-bind when room info is available for attacks

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (ENGINE_STATE !== 'GAME_ACTIVE') return;
      
      setActiveSlot(prev => {
        let next = e.deltaY > 0 ? prev + 1 : prev - 1;
        if (next > 8) next = 0;
        if (next < 0) next = 8;
        
        // Sync equipped item based on slot
        const p = playerRef.current;
        if (p) {
          if (next === 0) p.equippedItem = 'sword';
          else if (next === 1 && p.shovelUses && p.shovelUses > 0) p.equippedItem = (p.shovelUses > 10 || p.shovelUses === 30) ? 'super_shovel' : 'shovel'; // simplified logic for now
          else p.equippedItem = 'sword'; // empty slots act like sword for now
        }
        
        return next;
      });
    };
    
    // OPTIMIZATION: Passive event listener for scroll to prevent FPS drops
    window.addEventListener('wheel', handleWheel, { passive: true });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  const createDust = (x: number, y: number, color: string) => {
    for (let i = 0; i < 6; i++) particlesRef.current.push({ pos: { x, y }, vel: { x: (Math.random()-0.5)*4, y: (Math.random()-0.5)*4 }, life: 1, maxLife: 1, color, type: 'dust' });
  };
  const createSlash = (x: number, y: number, color: string) => {
    for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 2 + Math.random() * 4;
        particlesRef.current.push({ pos: { x, y }, vel: { x: Math.cos(a) * s, y: Math.sin(a) * s }, life: 1, maxLife: 1, color, type: 'slash' });
    }
  };

  const fireProjectile = (ownerId: string, pos: Vector, target: Vector, color: string, empireId?: EmpireType) => {
    const angle = Math.atan2(target.y - pos.y, target.x - pos.x);
    projectilesRef.current.push({
      id: generateId(),
      ownerId,
      pos: { ...pos },
      vel: { x: Math.cos(angle) * PROJECTILE_SPEED, y: Math.sin(angle) * PROJECTILE_SPEED },
      life: 1.0,
      damage: 60, // Projectile damage (will be modified by AoE later)
      color,
      empireId,
      targetPos: { ...target }
    });
    
    // Sync projectile creation so enemies can see it
    if (socketRef.current && currentRoomRef.current) {
        socketRef.current.emit('tower_fire', {
            roomId: currentRoomRef.current.id,
            ownerId,
            startX: pos.x,
            startY: pos.y,
            targetX: target.x,
            targetY: target.y,
            color,
            empireId
        });
    }
  };



  const fetchStats = async () => {
    // Supabase removed - Local persistence only
    const saved = localStorage.getItem('jan_stats');
    if (saved) setStats(JSON.parse(saved));
  };
  useEffect(() => { fetchStats(); }, [nickname]);

  const saveFinalStats = useCallback(async (isWin: boolean) => {
    const current = { ...stats };
    current.total_battles_count++;
    if (isWin) current.wins_count++;
    current.total_recruits += totalRecruitsMatch;
    current.total_kills += kills;
    setStats(current);
    localStorage.setItem('jan_stats', JSON.stringify(current));
  }, [stats, totalRecruitsMatch, kills]);

  const handleMouseDown = () => {
    isMouseDownRef.current = true;
    if (isSpectator) {
      setIsDraggingCamera(true);
    }
    
    // Axis locking for walls/gates
    if (isPlacingWall || isPlacingGate) {
      placementStartPosRef.current = { ...mouseWorldPosRef.current };
      placementAxisRef.current = null;
    }
  };

  const handleMouseUp = () => {
    isMouseDownRef.current = false;
    setIsDraggingCamera(false);
    placementStartPosRef.current = null;
    placementAxisRef.current = null;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (isSpectator && isDraggingCamera) {
      cameraRef.current.x -= e.movementX / cameraZoomRef.current;
      cameraRef.current.y -= e.movementY / cameraZoomRef.current;
      return;
    }

    // Convert screen coordinates to world coordinates - Fixed for consistency
    mouseWorldPosRef.current = {
      x: ((x - cv.width / 2) / cameraZoomRef.current) + cameraRef.current.x,
      y: ((y - cv.height / 2) / cameraZoomRef.current) + cameraRef.current.y
    };

    // Continuous building for walls and towers
    if (isMouseDownRef.current && (isPlacingWall || isPlacingTower)) {
      tryPlaceBuilding(mouseWorldPosRef.current.x, mouseWorldPosRef.current.y);
    }
  };

  const getBuildingNeighbors = (x: number, y: number) => {
    const n: { top?: Tower, bottom?: Tower, left?: Tower, right?: Tower } = {};
    const threshold = GRID_SIZE + 5;
    towersRef.current.forEach(t => {
      const dx = t.pos.x - x;
      const dy = t.pos.y - y;
      if (Math.abs(dx) < 5 && Math.abs(dy - threshold) < 10) n.bottom = t;
      else if (Math.abs(dx) < 5 && Math.abs(dy + threshold) < 10) n.top = t;
      else if (Math.abs(dy) < 5 && Math.abs(dx - threshold) < 10) n.right = t;
      else if (Math.abs(dy) < 5 && Math.abs(dx + threshold) < 10) n.left = t;
    });
    return n;
  };

  const tryPlaceBuilding = useCallback((worldX: number, worldY: number) => {
    if (gameState !== 'GAME_ACTIVE' || !playerRef.current || isSpectatorRef.current) return;
    if (!isPlacingWall && !isPlacingGate && !isPlacingTower) return;

    // NEW: Restriction - No building underground
    if (playerRef.current?.isUnderground) {
      showError(t.cantBuildUnderground || "Can't build underground!");
      setIsPlacingWall(false);
      setIsPlacingGate(false);
      setIsPlacingTower(false);
      return;
    }

    let targetX = worldX;
    let targetY = worldY;

    // Axis locking for continuous building
    if (isMouseDownRef.current && (isPlacingWall || isPlacingGate) && placementStartPosRef.current) {
        const dx = Math.abs(worldX - placementStartPosRef.current.x);
        const dy = Math.abs(worldY - placementStartPosRef.current.y);
        
        // Only set axis if we've moved significantly
        if (!placementAxisRef.current && (dx > 20 || dy > 20)) {
            placementAxisRef.current = dx > dy ? 'x' : 'y';
        }

        if (placementAxisRef.current === 'x') {
            targetY = placementStartPosRef.current.y;
        } else if (placementAxisRef.current === 'y') {
            targetX = placementStartPosRef.current.x;
        }
    }

    const p = playerRef.current;
    const bType = isPlacingWall ? 'wall' : (isPlacingGate ? 'gate' : 'tower');
    const price = UNIT_PRICES[bType];
    
    if (p.akce >= price) {
      const snapX = Math.floor(targetX / GRID_SIZE) * GRID_SIZE;
      const snapY = Math.floor(targetY / GRID_SIZE) * GRID_SIZE;
      const finalX = snapX + GRID_SIZE / 2;
      const finalY = snapY + GRID_SIZE / 2;

      // Check for overlap
      const isOverlapping = towersRef.current.some(t => {
          const dx = Math.abs(t.pos.x - finalX);
          const dy = Math.abs(t.pos.y - finalY);
          return dx < (GRID_SIZE - GRID_MARGIN) && dy < (GRID_SIZE - GRID_MARGIN);
      });

      if (isOverlapping) return; // Don't build on top of each other

      p.akce -= price;
      setPlayerAkce(p.akce);
      
      let rotation = 0;
      if (isPlacingWall || isPlacingGate) {
        const n = getBuildingNeighbors(finalX, finalY);
        // Priority 1: Axis Lock (for straight lines while dragging)
        if (placementAxisRef.current === 'x') {
          rotation = 0;
        } else if (placementAxisRef.current === 'y') {
          rotation = 90;
        }
        // Priority 2: Snap to existing neighbors
        else if (n.top || n.bottom) {
          rotation = 90;
        } 
        else if (n.left || n.right) {
          rotation = 0;
        }
        // Priority 3: Fallback to last placed wall relative position
        else if (lastWallPosRef.current) {
          const dx = Math.abs(finalX - lastWallPosRef.current.x);
          const dy = Math.abs(finalY - lastWallPosRef.current.y);
          rotation = dy > dx ? 90 : 0;
        }
      }
      
      const bId = generateId(bType);
      const maxHp = bType === 'tower' ? TOWER_MAX_HP : (bType === 'gate' ? GATE_MAX_HP : WALL_MAX_HP);
      const newBuilding: Tower = {
        id: bId,
        ownerId: myId,
        pos: { x: finalX, y: finalY },
        color: p.color,
        hp: maxHp,
        maxHp: maxHp,
        lastShot: 0,
        faction: p.faction,
        type: bType,
        rotation: rotation,
        isOpen: bType === 'gate' ? false : undefined,
        empireId: p.empireId
      };
      
      if (bType !== 'tower') lastWallPosRef.current = { x: finalX, y: finalY };
      towersBuiltRef.current++;
      shakeRef.current = bType === 'tower' ? 15 : 5;

      socketRef.current?.emit('building_placed', { 
        buildingId: bId,
        id: bId,
        roomId: currentRoom?.id, 
        type: bType.toUpperCase(), 
        x: finalX, 
        y: finalY, 
        faction: p.faction,
        hp: maxHp,
        rotation: rotation,
        ownerId: myId,
        isOpen: bType === 'gate' ? false : undefined,
        empireId: p.empireId
      });
    }
  }, [gameState, isPlacingWall, isPlacingGate, isPlacingTower, myId, currentRoom]);

  const handleCanvasClick = (e: React.MouseEvent | React.TouchEvent) => {
    if (gameState !== 'GAME_ACTIVE' || !playerRef.current || isSpectatorRef.current) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    
    // Get correct client coordinates for both Mouse and Touch
    const clientX = 'clientX' in e ? e.clientX : e.touches[0].clientX;
    const clientY = 'clientY' in e ? e.clientY : e.touches[0].clientY;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    // Convert to world coordinates - Fixed formula for exact pixel accuracy
    const worldX = ((x - cv.width / 2) / cameraZoomRef.current) + cameraRef.current.x;
    const worldY = ((y - cv.height / 2) / cameraZoomRef.current) + cameraRef.current.y;

    // If a panel is open or we are placing a building, clicking the canvas will cancel it
    if (showShop || activeSplitGarrisonId || isPlacingWall || isPlacingGate || isPlacingTower) {
      // First, handle building placement if we are in that mode
      if (isPlacingWall || isPlacingGate || isPlacingTower) {
        tryPlaceBuilding(worldX, worldY);
      }
      
      // Then cancel everything except continuous building
      setShowShop(false);
      setActiveSplitGarrisonId(null);
      // We don't want to cancel placing immediately on click because the user might want to click multiple times to build.
      // But we DO want to cancel if they clicked on empty space while a panel was open.
      if (showShop || activeSplitGarrisonId) {
        setIsPlacingWall(false);
        setIsPlacingGate(false);
        setIsPlacingTower(false);
      }
      
      // If we only placed a building, don't return so we don't accidentally cancel the placing state below
      if (showShop || activeSplitGarrisonId) return;
    }

    if (isPlacingWall || isPlacingGate || isPlacingTower) {
      tryPlaceBuilding(worldX, worldY);
      return;
    }

    const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    // Check for caravan click (Mobile Tap)
    if (isMobile) {
        const clickedCaravan = caravansRef.current.find(c => !c.escortOwnerId && getDistance({x: worldX, y: worldY}, c.pos) < 100);
        if (clickedCaravan) {
            const pHead = playerRef.current?.units[0];
            if (pHead && getDistance(clickedCaravan.pos, pHead.pos) < 250) {
                const sid = socketRef.current?.id || myId;
                socketRef.current?.emit('sync_data', { roomId: currentRoomRef.current?.id, caravanEscortRequest: clickedCaravan.id });
                createDust(clickedCaravan.pos.x, clickedCaravan.pos.y, '#fbbf24');
                if (isHostRef.current) {
                    clickedCaravan.escortOwnerId = sid;
                    clickedCaravan.escortTimer = 5;
                    clickedCaravan.lastAkceTime = Date.now();
                    clickedCaravan.outOfCircleTime = 0;
                }
                return;
            }
        }

        // Check for garrison click (Mobile Tap)
        const clickedGarrison = garrisonsRef.current.find(g => g.ownerId === myId && getDistance({x: worldX, y: worldY}, g.pos) < 100);
        if (clickedGarrison) {
            const pHead = playerRef.current?.units[0];
            if (pHead && getDistance(clickedGarrison.pos, pHead.pos) < 150) {
                // Rejoin
                playerRef.current.units.push(...clickedGarrison.units);
                const gIdx = garrisonsRef.current.findIndex(g => g.id === clickedGarrison.id);
                if (gIdx !== -1) garrisonsRef.current.splice(gIdx, 1);
                recentlyDestroyedGarrisons.current.set(clickedGarrison.id, Date.now());
                setPlayerGarrisons([...garrisonsRef.current.filter(xg => xg.ownerId === myId)]);
                createDust(clickedGarrison.pos.x, clickedGarrison.pos.y, clickedGarrison.color);
                socketRef.current?.emit('garrison_destroyed', { roomId: currentRoomRef.current?.id, garrisonId: clickedGarrison.id, ownerId: myId });
                lastSyncTimeRef.current = 0; 
                return;
            }
        }
    }

    // Check for building clicks (Sell logic OR Gate Toggle)
    const clickedBuildingIdx = towersRef.current.findIndex(t => {
      // For walls, they are long. We should check distance to the center of the grid cell
      // But t.pos IS the center of the grid cell.
      // Let's use a box collision check for better accuracy than pure distance,
      // especially since buildings are rectangular (GRID_SIZE x GRID_SIZE).
      
      const dx = Math.abs(worldX - t.pos.x);
      const dy = Math.abs(worldY - t.pos.y);
      
      // A building occupies exactly GRID_SIZE x GRID_SIZE area
      // We check if the click falls within this exact square
      return dx <= GRID_SIZE / 2 && dy <= GRID_SIZE / 2;
    });

    if (clickedBuildingIdx !== -1 && !isPlacingWall && !isPlacingGate && !isPlacingTower) {
      const b = towersRef.current[clickedBuildingIdx];
      
      // Ownership check: ID or faction color/string
      const currentId = socketRef.current?.id || myId;
      const isOwner = b.ownerId === currentId || b.color === playerColor || b.faction === playerColor;
      
      if (isOwner) {
        const pHead = playerRef.current?.units[0];
        if (b.type === 'gate' && isMobile && pHead && getDistance(b.pos, pHead.pos) < 150) {
            b.isOpen = !b.isOpen;
            createDust(b.pos.x, b.pos.y, '#fbbf24');
            socketRef.current?.emit('toggle_gate', { roomId: currentRoomRef.current?.id, buildingId: b.id, isOpen: b.isOpen });
            return;
        }

        // Since we have F for gates (on PC), we can use CLICK for selling EVERYTHING.
        // On mobile, tapping a gate while close toggles it (above), tapping it while far sells it.
        
        const refund = b.type === 'wall' ? 5 : (b.type === 'gate' ? 10 : 25);
        if (playerRef.current) {
          playerRef.current.akce += refund;
          setPlayerAkce(playerRef.current.akce);
          
          // Visual Feedback: +X Akçe floating text
          particlesRef.current.push({
            pos: { x: b.pos.x, y: b.pos.y },
            vel: { x: 0, y: -2 },
            life: 1,
            maxLife: 1,
            color: '#fbbf24', // Gold color
            type: 'text',
            text: `+${refund} Akçe`
          });
          
          // Dust effect
          createDust(b.pos.x, b.pos.y, '#fbbf24');
          
          // Emit destruction to server (Authoritative sync)
          socketRef.current?.emit('building_destroyed', { 
            roomId: currentRoomRef.current?.id, 
            buildingId: b.id 
          });
          return;
        }
      }
    }

    const clickedGarrison = garrisonsRef.current.find(g => 
      g.ownerId === playerRef.current?.id && getDistance({x: worldX, y: worldY}, g.pos) < 60
    );
    
    if (clickedGarrison) {
      clickedGarrison.mode = clickedGarrison.mode === 'HOLD' ? 'HUNT' : 'HOLD';
      shakeRef.current = 5;
    }
  };

  const startLobbyArena = useCallback((players: LobbyPlayer[]) => {
    setKills(0); setScore(1); setTotalRecruitsMatch(1); 
    worldSizeRef.current = LOBBY_WORLD_SIZE;
    const lobbyMap = MapGenerator.generate(123, LOBBY_WORLD_SIZE);
    gameMapRef.current = {
      obstacles: lobbyMap.obstacles,
      villages: lobbyMap.villages
    };
    caravansRef.current = [];
    
    const sid = socketRef.current?.id || myId;
    
    // Ensure the local player is ALWAYS included in the lobby even if server list is slightly delayed
    let playerList = [...players];
    if (sid && !playerList.find(p => p.id === sid)) {
        playerList.push({ 
            id: sid, 
            name: nickname || 'Sultan', 
            isHost: isHost,
            peerId: sid,
            isReady: false
        });
    }

    // Efficiently sync players without deleting existing entities
    const newEntities: Entity[] = playerList.map(p => {
      const existing = entitiesRef.current.find(e => e.id === p.id);
      const isMe = p.id === sid;

      if (existing) {
        existing.name = p.name || existing.name;
        // Reset units for rematch!
        const cached = playerSkinsRef.current.get(p.id);
        const factionColor = isMe ? playerColor : (cached?.faction || existing.color || '#94a3b8');
        
        existing.units = [{ 
            id: generateId(), 
            pos: { x: 600, y: 600 },
            color: factionColor, 
            type: 'infantry',
            hp: COMMANDER_MAX_HP
        }];
        existing.score = 1;
        existing.akce = 0;
        existing.color = factionColor;
        existing.isUnderground = false;
        existing.empireId = isMe ? initialEmpire.id : (p.empireId || cached?.empireId || existing.empireId || 'neutral'); 
        return existing;
      }
      
      const cached = playerSkinsRef.current.get(p.id);
      const remoteColor = cached?.faction || '#94a3b8'; // Use cached or neutral slate
      return {
        id: p.id,
        name: p.name || `Janissary #${p.id.slice(0, 3)}`,
        type: 'player',
        units: [{ 
            id: generateId(), 
            color: isMe ? playerColor : remoteColor, 
            pos: { x: 600, y: 600 }, 
            type: 'infantry',
            hp: COMMANDER_MAX_HP
        }],
        color: isMe ? playerColor : remoteColor,
        faction: isMe ? playerColor : remoteColor,
        empireId: isMe ? initialEmpire.id : (p.empireId || cached?.empireId || 'neutral'),
        score: 1,
        akce: 0,
        isDashing: false,
        velocity: { x: 0, y: 0 },
        facingAngle: 0,
        isAttacking: false,
        attackTimer: 0,
        attackCooldown: 0,
        weightSlowdown: 0,
        splitCooldown: 0,
        isUnderground: false
      };
    });

    entitiesRef.current = newEntities;
    const me = entitiesRef.current.find(p => p.id === sid);
    if (me) playerRef.current = me;
    
    neutralsRef.current = [];
    towersRef.current = [];
    projectilesRef.current = [];
    particlesRef.current = [];
    garrisonsRef.current = [];

    // Snap camera to lobby center
    cameraRef.current = { x: 600, y: 600 };
  }, [myId, nickname, isHost]);

  const initGame = useCallback((seed: number, players: Entity[]) => {
    // Initialize battle arena
    setKills(0); setScore(1); setTotalRecruitsMatch(1); 
    
    // Dynamic World Size based on player count
    const playerCount = players?.length || 1;
    const dynamicSize = Math.max(WORLD_SIZE, WORLD_SIZE + (playerCount - 3) * 1000);
    worldSizeRef.current = dynamicSize; 
    
    startTimeRef.current = Date.now();
    
    // 3-second Spawn Protection
    spawnProtectionRef.current = true;
    setTimeout(() => { spawnProtectionRef.current = false; }, 3000);
    
    // Generate map with dynamic size
    const mapData = MapGenerator.generate(seed, dynamicSize, playerCount);
    gameMapRef.current = {
      obstacles: mapData.obstacles,
      villages: mapData.villages
    };
    caravansRef.current = [];
    
    const sid = socketRef.current?.id || myId;
    
    // Dynamic Spawn Points calculation
    const getSpawnPos = (idx: number) => {
      const margin = 500;
      const size = dynamicSize;
      const points = [
        { x: margin, y: margin },
        { x: size - margin, y: size - margin },
        { x: margin, y: size - margin },
        { x: size - margin, y: margin },
        { x: size / 2, y: margin },
        { x: size / 2, y: size - margin },
        { x: margin, y: size / 2 },
        { x: size - margin, y: size / 2 }
      ];
      return points[idx % points.length] || { x: size / 2, y: size / 2 };
    };

    // Reuse lobby entities to maintain persistence
    entitiesRef.current = (players || []).map((p, idx) => {
      const existing = entitiesRef.current.find(e => e.id === p.id);
      const isLocal = p.id === sid;
      const sPos = getSpawnPos(idx);

      if (existing) {
        if (existing.units[0]) {
          existing.units[0].pos = { ...sPos };
          existing.units[0].hp = COMMANDER_MAX_HP;
        }
        existing.isUnderground = false;
        return existing;
      }
      return {
        ...p,
        name: isLocal ? nickname : p.name,
        color: isLocal ? playerColor : (p.color || '#94a3b8'), 
        faction: isLocal ? playerColor : (p.faction || '#94a3b8'),
        units: [{ id: generateId(), color: isLocal ? playerColor : (p.color || '#94a3b8'), pos: { ...sPos }, type: 'infantry', hp: COMMANDER_MAX_HP }],
        score: p.score || 1,
        akce: p.akce || 0,
        isDashing: false,
        velocity: {x: 0, y:0},
        facingAngle: 0,
        isAttacking: false,
        attackTimer: 0,
        attackCooldown: 0,
        weightSlowdown: 0,
        splitCooldown: 0,
        isUnderground: false
      };
    });
    
    const me = entitiesRef.current.find(p => p.id === sid);
    if (me) playerRef.current = me;

    const rand = new SeededRandom(seed + 1);
    const neutrals: Unit[] = [];
    
    // 1. Exactly 80 neutrals scattered randomly across the map
    for (let i = 0; i < 80; i++) {
        neutrals.push({
          id: `neutral_${i}`, // Deterministic ID for cross-client sync
          pos: { 
            x: 100 + rand.next() * (dynamicSize - 200), 
            y: 100 + rand.next() * (dynamicSize - 200) 
          },
          color: '#94a3b8',
          type: 'infantry',
          hp: 100,
          empireId: 'neutral'
        });
    }

    neutralsRef.current = neutrals;
    setActivePlayers(entitiesRef.current.length);
    setPlayerAkce(0);
    garrisonsRef.current = [];
    
    // Neutral Towers removed per Sultan's Refinement
    towersRef.current = [];

    projectilesRef.current = [];
    particlesRef.current = []; 
    
    // FORCE STATE CHANGE
    // Finalize state change to active battle
    setGameState('GAME_ACTIVE');
    ENGINE_STATE = 'GAME_ACTIVE';
    gameStateRef.current = 'GAME_ACTIVE';
    setCountdown(null);
    lastSyncTimeRef.current = Date.now();
    
    // Snap camera to player world position
    if (playerRef.current && playerRef.current.units[0]) {
      cameraRef.current = {
        x: playerRef.current.units[0].pos.x,
        y: playerRef.current.units[0].pos.y
      };
      
      // Emit initial sync to inform server of teleport
      if (socketRef.current && currentRoomRef.current) {
        socketRef.current.emit('sync_data', {
          x: playerRef.current.units[0].pos.x,
          y: playerRef.current.units[0].pos.y,
          rotation: playerRef.current.facingAngle,
          units: playerRef.current.units, // Full Squad Sync
          unitCount: Math.max(0, playerRef.current.units.length - 1),
          akce: playerRef.current.akce,
          faction: playerRef.current.faction,
          roomId: currentRoomRef.current.id,
          isUnderground: false
        });
      }
    }
  }, [myId]);

  useEffect(() => {
    if (gameState === 'LOBBY_WAITING' && currentRoom && isHost) {
      const pCount = (currentRoom.players || []).length;
      if (pCount >= (currentRoom.limit || currentRoom.maxPlayers || 10) && countdown === null) {
        socketRef.current?.emit('start_countdown', { roomId: currentRoom.id });
      }
    }
  }, [currentRoom, gameState, countdown, isHost]);



  const lastFrameTimeRef = useRef<number>(performance.now());
  const update = useCallback(() => {
    try {
        if (ENGINE_STATE !== 'GAME_ACTIVE' && ENGINE_STATE !== 'LOBBY_WAITING') {
      frameId.current = requestAnimationFrame(update);
      return;
    }

    const dt = 16.67; // Fixed step (60 FPS)
    const dt_scale = 1; // Fixed scale for original speed

    const p = playerRef.current;
    
    // DEBUG: Ensure playerRef is always synced with local player entity
    const sid = socketRef.current?.id || myId;
    if (!p || p.id !== sid) {
        const localEnt = entitiesRef.current.find(e => e.id === sid);
        if (localEnt) {
            playerRef.current = localEnt;
        }
    }

    if (!playerRef.current) {
      frameId.current = requestAnimationFrame(update);
      return;
    }

    const currentWorldSize = worldSizeRef.current;
    if (shakeRef.current > 0) shakeRef.current *= 0.9;
    frameCountRef.current++; // Increment frame counter
    
    // 1. State & Cooldowns (all entities)
    entitiesRef.current.forEach(ent => {
        if (ent.units.length === 0) return;
        
        // Attack timers
        if (ent.attackTimer > 0) { 
            ent.attackTimer -= dt; 
            if (ent.attackTimer <= 0) {
                ent.isAttacking = false; 
                ent.hasHitInCurrentSwing = false; 
                ent.swingKills = 0; 
            }
        }
        if (ent.attackCooldown > 0) ent.attackCooldown -= dt;
        if (ent.weightSlowdown > 0) ent.weightSlowdown -= dt;
        
        // Income (Reliable income using dt)
        ent.incomeTimer = (ent.incomeTimer || 0) + dt;
        if (ent.incomeTimer >= 1000) {
          ent.akce += 1;
          ent.incomeTimer -= 1000;
          if (ent.id === myId) setPlayerAkce(ent.akce);
        }
        
        // Dash cost & effect
        if (ent.isDashing && ent.units.length > MIN_UNITS_TO_DASH) {
          ent.score -= DASH_COST_PER_FRAME * dt_scale;
          if (Math.floor(ent.score) < ent.units.length && ent.units.length > 1) {
            ent.units.pop();
            if (ent.id === myId) setScore(ent.units.length);
          }
        }
    });

    // Dash Input Check (Local Only)
    const lp = playerRef.current;
    if (lp && (keysRef.current['ShiftLeft'] || keysRef.current['ShiftRight']) && lp.akce >= 20 && lp.splitCooldown <= 0) {
        lp.isDashing = true;
        lp.akce -= 20;
        lp.splitCooldown = 500;
        setPlayerAkce(lp.akce);
        setTimeout(() => { if (playerRef.current) playerRef.current.isDashing = false; }, 300);
    }
    if (lp && lp.splitCooldown > 0) lp.splitCooldown -= dt;

    garrisonsRef.current.forEach(g => {
        if (g.attackTimer > 0) {
            g.attackTimer -= dt;
            if (g.attackTimer <= 0) {
              g.swingKills = 0;
            }
        }
        if (g.attackCooldown > 0) g.attackCooldown -= dt;
    });

    // 2. Camera Update
    if (!isSpectatorRef.current && p && p.units[0]) {
      cameraRef.current.x += (p.units[0].pos.x - cameraRef.current.x) * 0.1 * dt_scale;
      cameraRef.current.y += (p.units[0].pos.y - cameraRef.current.y) * 0.1 * dt_scale;
    }

    // Pre-initialize garrison map for use in movement/AI logic
    const garrisonMap = new Map<string, Garrison>();
    garrisonsRef.current.forEach(g => garrisonMap.set(g.id, g));

    // 3. Movement & Physics (Entities)
    entitiesRef.current.forEach(ent => {
        if (ent.units.length === 0) return;
        const sid = socketRef.current?.id || myId;
        const isLocalPlayer = ent.id === sid;
        const head = ent.units[0];

        // --- INTERPOLATION FOR REMOTE PLAYERS ---
        if (!isLocalPlayer && ent.targetPos) {
            // Smoothly move remote head unit to targetPos
            const lerpFactor = 1 - Math.pow(1 - 0.35, dt_scale);
            head.pos.x += (ent.targetPos.x - head.pos.x) * lerpFactor;
            head.pos.y += (ent.targetPos.y - head.pos.y) * lerpFactor;
            
            // Smoothly rotate remote entity to targetAngle
            if (ent.targetAngle !== undefined) {
                let diff = ent.targetAngle - ent.facingAngle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                ent.facingAngle += diff * 0.25 * dt_scale;
            }
        }
        
        const mass = ent.units.length;
        const inertia = mass < 10 ? 1 : 1 + (mass - 10) * MASS_INERTIA_FACTOR;
        const spd = (ent.isDashing && ent.units.length > MIN_UNITS_TO_DASH ? PLAYER_SPEED * DASH_MULTIPLIER : PLAYER_SPEED);
        const accel = ((ent.panicTimer ? BASE_ACCEL * 4 : BASE_ACCEL) / inertia) * dt_scale;

        let targetVel = { x: 0, y: 0 };
        if (isLocalPlayer) {
            if (!isSpectatorRef.current) {
                if (keyboardDir.current.x !== 0 || keyboardDir.current.y !== 0) targetVel = { ...keyboardDir.current }; 
                else if (joystickDir.current.x !== 0 || joystickDir.current.y !== 0) targetVel = { ...joystickDir.current };
            }
        } else if (ent.type === 'ai' && !isMultiplayer) {
            // Throttle AI decision making (every 10 frames)
            const shouldDecide = (frameCountRef.current + ent.units.length) % 10 === 0;
            
            if (ent.panicTimer && ent.panicTimer > 0) {
                ent.panicTimer -= 1;
                const panicAngle = (ent.facingAngle || 0) + Math.PI; 
                targetVel = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
                if (ent.panicTimer === 0) ent.facingAngle = (ent.facingAngle || 0) + Math.PI / 2;
            } else if (shouldDecide) {
                let targetPos: any = null;
                let minDist = Infinity;
                let targetEntity: any = null;
                
                // Find nearest enemy using spatial grid
                const hgx = (head.pos.x / GRID_CELL_SIZE) | 0, hgy = (head.pos.y / GRID_CELL_SIZE) | 0;
                // AI search reduced to 7x7 grid (approx 1000px) for performance
                for (let dx = -7; dx <= 7; dx++) {
                    for (let dy = -7; dy <= 7; dy++) {
                        const cell = spatialGridRef.current.get(gridKey(hgx + dx, hgy + dy));
                        if (cell) {
                            for (const n of cell) {
                                // Ignore self and neutral (unless small)
                                let tId = n.entityId;
                                if (tId.startsWith('g_')) {
                                    const gt = garrisonMap.get(tId.substring(2));
                                    if (gt) tId = gt.ownerId;
                                }
                                if (tId !== ent.id && tId !== 'neutral') {
                                    const d = getDistance(head.pos, n.unit.pos);
                                    if (d < minDist) { minDist = d; targetPos = n.unit.pos; }
                                }
                            }
                        }
                    }
                }

                const swarmSize = ent.units.length;
                if (swarmSize < 20 && !targetPos) {
                    let nearestNeutral: any = null; let minNeutralDist = Infinity;
                    // Find nearest neutral using spatial grid
                    for (let dx = -8; dx <= 8; dx++) {
                        for (let dy = -8; dy <= 8; dy++) {
                            const cell = spatialGridRef.current.get(gridKey(hgx + dx, hgy + dy));
                            if (cell) {
                                for (const n of cell) {
                                    if (n.entityId === 'neutral') {
                                        const d = getDistance(head.pos, n.unit.pos);
                                        if (d < minNeutralDist) { minNeutralDist = d; nearestNeutral = n.unit; }
                                    }
                                }
                            }
                        }
                    }
                    if (nearestNeutral) targetPos = nearestNeutral.pos;
                } else if (targetPos) {
                    // Logic for attack/flee
                    if (minDist < 100 && ent.attackCooldown <= 0) { ent.isAttacking = true; ent.attackTimer = 300; ent.attackCooldown = 800; }
                }
                
                ent.cachedTargetPos = targetPos;
                ent.cachedMinDist = minDist;
            }
            
            const targetPos = ent.cachedTargetPos;
            if (targetPos) {
                const distToTarget = getDistance(head.pos, targetPos);
                if (distToTarget > 20) {
                    const a = Math.atan2(targetPos.y - head.pos.y, targetPos.x - head.pos.x);
                    targetVel = { x: Math.cos(a), y: Math.sin(a) };
                }
            }
            // Stuck detection (throttled)
            if (frameCountRef.current % 5 === 0) {
                if (!ent.lastPos) ent.lastPos = { ...head.pos };
                if (targetVel.x !== 0 || targetVel.y !== 0) {
                    if (getDistance(head.pos, ent.lastPos) < 1) {
                        ent.stuckTimer = (ent.stuckTimer || 0) + 1;
                        if (ent.stuckTimer > 40) { ent.panicTimer = 30; ent.stuckTimer = 0; ent.facingAngle = (ent.facingAngle || 0) + Math.PI/2; }
                    } else ent.stuckTimer = 0;
                }
                ent.lastPos = { ...head.pos };
            }
        }

        // Apply physics with inertia (using mass/inertia/accel calculated above)
        ent.velocity = ent.velocity || { x: 0, y: 0 };
        ent.velocity.x += (targetVel.x - ent.velocity.x) * accel;
        ent.velocity.y += (targetVel.y - ent.velocity.y) * accel;
        ent.velocity.x *= Math.pow(BASE_FRICTION, dt_scale);
        ent.velocity.y *= Math.pow(BASE_FRICTION, dt_scale);

        if (targetVel.x !== 0 || targetVel.y !== 0) {
            const targetAngle = Math.atan2(targetVel.y, targetVel.x);
            let diff = targetAngle - (ent.facingAngle || 0);
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            ent.facingAngle = (ent.facingAngle || 0) + diff * (0.15 / inertia) * dt_scale;
        }

        // Tunnel Entrance Interaction
        if (ent.id === sid) {
            let foundTunnel: any = null;
            // Now look for tunnels inside towers array
            towersRef.current.forEach(b => {
                if (b.type === ('tunnel' as any) && getDistance(head.pos, b.pos) < 120) {
                    foundTunnel = b;
                }
            });

            // Enter/Exit via 'F'
            const isFPressedLocal = keysRef.current['f'] || keysRef.current['F'] || keysRef.current['KeyF'];
            const isRPressedLocal = keysRef.current['r'] || keysRef.current['R'] || keysRef.current['KeyR'];
            
            if (foundTunnel && isFPressedLocal) {
                if (!ent.lastTunnelToggle || Date.now() - ent.lastTunnelToggle > 800) {
                    ent.isUnderground = !ent.isUnderground;
                    ent.lastTunnelToggle = Date.now();
                    createDust(head.pos.x, head.pos.y, '#78350f');
                    if (keysRef.current['f']) keysRef.current['f'] = false;
                    if (keysRef.current['F']) keysRef.current['F'] = false;
                    if (keysRef.current['KeyF']) keysRef.current['KeyF'] = false;
                }
            }

            // Hide/Destroy via 'R' (Only if owner)
            const isOwner = foundTunnel && (foundTunnel.ownerId === myId || foundTunnel.ownerId === playerRef.current?.id);
            if (foundTunnel && isOwner && isRPressedLocal) {
                const tid = foundTunnel.id;
                if (socketRef.current) {
                    const currentRoomId = currentRoomRef.current?.id || (window as any).currentRoomId || '';
                    socketRef.current.emit('building_destroyed', { roomId: currentRoomId, buildingId: tid });
                }
                if (keysRef.current['r']) keysRef.current['r'] = false;
                if (keysRef.current['R']) keysRef.current['R'] = false;
                if (keysRef.current['KeyR']) keysRef.current['KeyR'] = false;
            }
        }

        if (ent.id === myId || (socketRef.current?.id && ent.id === socketRef.current.id)) {
            let finalSpd = spd * dt_scale;
            if (ent.isAttacking && ent.cachedMinDist && ent.cachedMinDist < 150) {
                finalSpd *= 1.25;
            }
            
            // Underground players ignore obstacles and towers
            const obstaclesToUse = ent.isUnderground ? [] : gameMapRef.current.obstacles;
            const towersToUse = ent.isUnderground ? [] : towersRef.current;
            
            const nextPos = resolveCollision(head.pos, { x: ent.velocity.x * finalSpd, y: ent.velocity.y * finalSpd }, obstaclesToUse, towersToUse);
            if (nextPos.x > 0 && nextPos.x < currentWorldSize) head.pos.x = nextPos.x;
            if (nextPos.y > 0 && nextPos.y < currentWorldSize) head.pos.y = nextPos.y;
        } else if (ent.type === 'ai' && !isMultiplayer) {
            // AI movement
            head.pos.x += ent.velocity.x * spd * dt_scale;
            head.pos.y += ent.velocity.y * spd * dt_scale;
        }
        // Note: Remote players (non-AI) only use interpolation (above), no velocity move here to avoid double movement
        ent.lastPos = { ...head.pos };

        // Swarm cohesion for all units
        const angle = (ent.facingAngle || 0) + Math.PI / 2;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const isLocal = ent.id === sid;

        // FIXED: Using frame-rate independent LERP for all unit swarms
        // Increased attack lerp speed for sharper "charge" feel
        const lerpBaseSpeed = isLocal ? (ent.isAttacking ? 0.045 : 0.015) : 0.025;
        const lerpFactor = 1 - Math.exp(-lerpBaseSpeed * dt);
        
        // Optimization: Large armies use coarser cohesion logic
        const unitCount = ent.units.length;
        const skipStep = unitCount > 150 ? 2 : 1;

        for (let i = 1; i < unitCount; i += 1) {
            const u = ent.units[i];
            
            // For very large armies, we can skip expensive trig/cohesion for some units
            // and just make them follow the unit ahead of them (much cheaper)
            if (skipStep > 1 && i % skipStep !== 0) {
                const prev = ent.units[i-1];
                const followLerp = 1 - Math.exp(-0.06 * dt); // Sharper follow
                u.pos.x += (prev.pos.x - u.pos.x) * followLerp;
                u.pos.y += (prev.pos.y - u.pos.y) * followLerp;
                continue;
            }

            let ox, oy;
            if (ent.isDashing) {
                const row = Math.sqrt(i) | 0, colInRow = i - row * row;
                ox = (colInRow - row) * (UNIT_RADIUS * 2.5); oy = (row + 1) * (UNIT_RADIUS * 3.5);
            } else {
                // TRAVEL & ATTACK FORMATION: Consistent 5-column layout
                // User requested attack to NOT change formation shape
                const xSpacing = 32, ySpacing = 38, cols = 5;
                const row = ((i - 1) / cols) | 0, col = (i - 1) % cols;
                ox = (col - 2) * xSpacing; oy = (row + 1) * ySpacing;
            }
            
            const tx = head.pos.x + (ox * cosA - oy * sinA);
            const ty = head.pos.y + (ox * sinA + oy * cosA);
            u.pos.x += (tx - u.pos.x) * lerpFactor;
            u.pos.y += (ty - u.pos.y) * lerpFactor;
        }
    });

    // Garrison Movement & Physics
    garrisonsRef.current.forEach((g, idx) => {
        if (g.units.length === 0) return;
        
        // Ownership check: only owner (or host for AI) calculates logic. Others just LERP.
        const isOwner = g.ownerId === myId || (socketRef.current?.id && g.ownerId === socketRef.current.id);
        const shouldCalculate = isOwner || (isMultiplayer && isHostRef.current && g.ownerId === 'ai');

        if (!shouldCalculate) {
            // REMOTE GARRISON: Strictly follow network sync data
            if (g.lastSyncPos) {
                // Smoothly interpolate towards last synced position (LERP)
                const lerpSpd = 1 - Math.exp(-0.015 * dt);
                g.pos.x += (g.lastSyncPos.x - g.pos.x) * lerpSpd;
                g.pos.y += (g.lastSyncPos.y - g.pos.y) * lerpSpd;

                // Dead Reckoning (Prediction)
                // If we have a targetPos from the owner, move locally towards it 
                // between sync packets to ensure absolute smoothness.
                if (g.targetPos && (g.mode === 'HUNT' || g.mode === 'RECALL')) {
                    const angle = Math.atan2(g.targetPos.y - g.pos.y, g.targetPos.x - g.pos.x);
                    const dist = getDistance(g.pos, g.targetPos);
                    const stopDist = (g.mode === 'RECALL') ? 50 : 35;
                    if (dist > stopDist) {
                        const speedScale = Math.min(1, (dist - stopDist) / 50);
                        const moveSpd = (g.mode === 'RECALL' ? 0.36 : 0.27) * dt * (0.8 + 0.2 * speedScale);
                        // Apply a fraction of the movement to the local position
                        // This fills the gap between 50ms sync intervals
                        g.pos.x += Math.cos(angle) * moveSpd * 0.5;
                        g.pos.y += Math.sin(angle) * moveSpd * 0.5;
                    }
                }
            }
            
            // Sync unit positions to the interpolated g.pos
            // Remote units MUST use the same formation logic as the owner
            const isMoving = g.mode !== 'HOLD';
            const lerpSpeed = isMoving ? 0.025 : 0.01;
            const unitLerp = 1 - Math.exp(-lerpSpeed * dt);

            g.units.forEach((u, i) => {
                // MATCHING OWNER FORMATION: 4-column wide squad
                const row = Math.floor(i / 4), col = i % 4; 
                const ox = (col - 1.5) * 35, oy = (row + 1) * 35;
                const tx = g.pos.x + ox, ty = g.pos.y + oy;
                u.pos.x += (tx - u.pos.x) * unitLerp;
                u.pos.y += (ty - u.pos.y) * unitLerp;
            });
            return; // Skip local logic for remote garrisons
        }

        // LOCAL GARRISON LOGIC (Calculated only by owner/host)
        if (g.units.length === 1 && g.mode !== 'RECALL') {
            g.mode = 'RECALL';
        }

        // Throttle heavy AI/Detection logic (every 10 frames for each garrison)
        // Ensure idx is defined by checking the forEach signature above
        let shouldRunHeavyLogic = (frameCountRef.current + (idx || 0)) % 10 === 0;

        if (g.mode === 'HOLD') {
            if (shouldRunHeavyLogic) {
                // AUTO-TRANSITION TO HUNT: Search for enemies using spatial grid (O(1) search)
                let nearestEnemyDist = Infinity;
                const hgx = (g.pos.x / GRID_CELL_SIZE) | 0, hgy = (g.pos.y / GRID_CELL_SIZE) | 0;
                
                // Search in a 3x3 grid around the garrison (roughly 450px)
                for (let dx = -3; dx <= 3; dx++) {
                    for (let dy = -3; dy <= 3; dy++) {
                        const cell = spatialGridRef.current.get(gridKey(hgx + dx, hgy + dy));
                        if (cell) {
                            for (const n of cell) {
                                // Extract true owner ID (handle garrisons)
                                let tId = n.entityId;
                                if (tId.startsWith('g_')) {
                                    const gt = garrisonMap.get(tId.substring(2));
                                    if (gt) tId = gt.ownerId;
                                }
                                if (tId !== g.ownerId && tId !== 'neutral') {
                                    const d = getDistance(g.pos, n.unit.pos);
                                    if (d < nearestEnemyDist) nearestEnemyDist = d;
                                }
                            }
                        }
                    }
                }

                if (nearestEnemyDist < 450) {
                    g.mode = 'HUNT';
                    // FIXED: Immediate target acquisition on transition to prevent "stuck" frames
                    shouldRunHeavyLogic = true; 
                } else {
                    // Also check for buildings to transition to HUNT
                    towersRef.current.forEach(t => {
                        if (t.ownerId === g.ownerId || t.color === g.color) return;
                        const d = getDistance(g.pos, t.pos);
                        if (d < 450) {
                            g.mode = 'HUNT';
                            shouldRunHeavyLogic = true;
                        }
                    });
                }
            }
        }
        
        if (g.mode === 'HUNT' || g.mode === 'RECALL') {
            let targetPos: Vector | null = null;
            if (g.mode === 'RECALL') {
                const owner = entitiesRef.current.find(e => e.id === g.ownerId);
                if (owner && owner.units[0]) targetPos = owner.units[0].pos;
            } else if (shouldRunHeavyLogic) {
                // Hunt nearest enemy using spatial grid
                let minDist = 1200;
                const hgx = (g.pos.x / GRID_CELL_SIZE) | 0, hgy = (g.pos.y / GRID_CELL_SIZE) | 0;
                
                for (let dx = -6; dx <= 6; dx++) {
                    for (let dy = -6; dy <= 6; dy++) {
                        const cell = spatialGridRef.current.get(gridKey(hgx + dx, hgy + dy));
                        if (cell) {
                            for (const n of cell) {
                                let tId = n.entityId;
                                if (tId.startsWith('g_')) {
                                    const gt = garrisonMap.get(tId.substring(2));
                                    if (gt) tId = gt.ownerId;
                                }
                                if (tId !== g.ownerId && tId !== 'neutral') {
                                    const d = getDistance(g.pos, n.unit.pos);
                                    if (d < minDist) { minDist = d; targetPos = n.unit.pos; }
                                }
                            }
                        }
                    }
                }

                // NEW: Also check for nearest enemy buildings
                towersRef.current.forEach(t => {
                    if (t.ownerId === g.ownerId || t.color === g.color) return;
                    const d = getDistance(g.pos, t.pos);
                    if (d < minDist) {
                        minDist = d;
                        targetPos = t.pos;
                    }
                });

                g.targetPos = targetPos; // Cache for throttled frames
            } else {
                targetPos = g.targetPos;
            }

            if (targetPos) {
                const angle = Math.atan2(targetPos.y - g.pos.y, targetPos.x - g.pos.x);
                const dist = getDistance(g.pos, targetPos);
                const stopDist = (g.mode === 'RECALL') ? 50 : 35;
                
                if (dist > stopDist) {
                    // FIXED: Smoother movement for garrisons to prevent "shaking"
                    // Scale speed slightly by distance when getting close to stopDist
                    const speedScale = Math.min(1, (dist - stopDist) / 50);
                    // FIXED: Using dt for frame-rate independent movement speed
                    const moveSpd = (g.mode === 'RECALL' ? 0.36 : 0.27) * dt * (0.8 + 0.2 * speedScale);
                    
                    g.pos.x += Math.cos(angle) * moveSpd;
                    g.pos.y += Math.sin(angle) * moveSpd;
                } else if (g.mode === 'RECALL') {
                    if (g.ownerId === myId) {
                        const me = entitiesRef.current.find(e => e.id === myId);
                        if (me) {
                            me.units.push(...g.units);
                            g.units = [];
                        }
                    }
                }
                
                if (g.mode === 'HUNT' && dist < 85 && g.attackCooldown <= 0) {
                    g.attackTimer = 350;
                    g.attackCooldown = 700;
                    g.swingKills = 0;
                }
            }
        }
        
        // Update all unit positions in garrison with dynamic LERP
        // Higher lerp factor when moving/attacking for crisp response
        const isMoving = g.mode !== 'HOLD' && g.targetPos;
        
        // FIXED: Using frame-rate independent LERP formula: 1 - Math.exp(-speed * dt)
        // This ensures units move at the same speed regardless of FPS drops
        const lerpSpeed = isMoving ? 0.025 : 0.01;
        const unitLerp = 1 - Math.exp(-lerpSpeed * dt);
        
        g.units.forEach((u, i) => {
            // FIXED: Increased formation spacing (35px instead of 24px) to prevent overlapping "shaking"
            const row = Math.floor(i / 4), col = i % 4; // Use 4 columns for slightly wider squad
            const ox = (col - 1.5) * 35, oy = (row + 1) * 35;
            const tx = g.pos.x + ox, ty = g.pos.y + oy;
            u.pos.x += (tx - u.pos.x) * unitLerp;
            u.pos.y += (ty - u.pos.y) * unitLerp;
        });
    });

    // 4. Populate Spatial Grid (WITH FRESH POSITIONS)
    spatialGridRef.current.clear();
    const entityMap = new Map<string, Entity>();
    
    // Optimization: Pre-calculate vision radius squared
    const VISION_RADIUS_SQ = 1200 * 1200;
    const localHeadPos = playerRef.current?.units[0]?.pos;
    
    const isLocalInView = (pos: Vector) => {
        if (!localHeadPos) return true;
        const dx = pos.x - localHeadPos.x;
        const dy = pos.y - localHeadPos.y;
        return (dx*dx + dy*dy) < VISION_RADIUS_SQ;
    };

    // Optimization: Skip spatial grid for entities far away
    entitiesRef.current.forEach(ent => {
        entityMap.set(ent.id, ent);
        if (ent.units.length === 0) return;
        
        const isMe = ent.id === myId || (socketRef.current?.id && ent.id === socketRef.current.id);
        const inView = isLocalInView(ent.units[0].pos);
        if (!isMe && !inView) return;

        ent.units.forEach((u, i) => {
            // Aggressive skip for remote/distant units to save O(N) spatial grid insertions
            // FIXED: Skip every 4th unit for remote armies to save CPU
            if (!isMe && ent.units.length > 40 && i % 4 !== 0) return;

            const gx = (u.pos.x / GRID_CELL_SIZE) | 0;
            const gy = (u.pos.y / GRID_CELL_SIZE) | 0;
            const key = gridKey(gx, gy);
            let cell = spatialGridRef.current.get(key);
            if (!cell) {
                cell = [];
                spatialGridRef.current.set(key, cell);
            }
            // FIXED: Max 20 units per cell to prevent quadratic slowdowns
            if (cell.length < 20) cell.push({ unit: u, entityId: ent.id });
        });
    });

    garrisonsRef.current.forEach(g => {
        if (g.units.length === 0) return;
        
        const isMyGarrison = g.ownerId === myId || (socketRef.current?.id && g.ownerId === socketRef.current.id);
        const inView = isLocalInView(g.pos);
        if (!isMyGarrison && !inView) return;

        g.units.forEach((u, i) => {
            // FIXED: Aggressive skip for remote garrisons
            if (!isMyGarrison && g.units.length > 30 && i % 4 !== 0) return;

            const gx = (u.pos.x / GRID_CELL_SIZE) | 0;
            const gy = (u.pos.y / GRID_CELL_SIZE) | 0;
            const key = gridKey(gx, gy);
            let cell = spatialGridRef.current.get(key);
            if (!cell) {
                cell = [];
                spatialGridRef.current.set(key, cell);
            }
            if (cell.length < 20) cell.push({ unit: u, entityId: `g_${g.id}` });
        });
    });

    neutralsRef.current.forEach(n => {
        if (!isLocalInView(n.pos)) return;
        const gx = (n.pos.x / GRID_CELL_SIZE) | 0;
        const gy = (n.pos.y / GRID_CELL_SIZE) | 0;
        const key = gridKey(gx, gy);
        let cell = spatialGridRef.current.get(key);
        if (!cell) {
            cell = [];
            spatialGridRef.current.set(key, cell);
        }
        if (cell.length < 15) cell.push({ unit: n, entityId: 'neutral' });
    });

    // 5. Combat & Interactions
    const unitsToRemove = new Set<string>();

    if (ENGINE_STATE === 'GAME_ACTIVE') {
      // Neutral Recruitment
      entitiesRef.current.forEach(ent => {
        if (ent.units.length === 0 || ent.isUnderground) return; // NEW: Underground can't recruit surface neutrals
        const head = ent.units[0];
        const gx = Math.floor(head.pos.x / GRID_CELL_SIZE);
        const gy = Math.floor(head.pos.y / GRID_CELL_SIZE);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const key = gridKey(gx + dx, gy + dy);
            const neighbors = spatialGridRef.current.get(key);
            if (!neighbors) continue;
            for (let i = neighbors.length - 1; i >= 0; i--) {
              const neighbor = neighbors[i];
              if (neighbor.entityId !== 'neutral') continue;
              if (getDistance(head.pos, neighbor.unit.pos) < 70) {
                ent.units.push({ ...neighbor.unit, color: ent.color, empireId: ent.empireId });
                neutralsRef.current = neutralsRef.current.filter(nu => nu.id !== neighbor.unit.id);
                neighbors.splice(i, 1);
                if (ent.id === myId) { 
                  setTotalRecruitsMatch(r => r + 1); 
                  setScore(ent.units.length);
                  pendingRecruitsRef.current.add(neighbor.unit.id);
                }
              }
            }
          }
        }
      });

      // Melee Combat (Entities)
      const frameDamageMap = new Map<string, number>();
      entitiesRef.current.forEach(e1 => {
        if (e1.units.length === 0) return;
        
        const isOwner = e1.id === myId || (socketRef.current?.id && e1.id === socketRef.current.id);
        const shouldCalculate = isOwner || (!isMultiplayer && e1.type === 'ai') || (isMultiplayer && isHostRef.current && e1.type === 'ai');
        if (!shouldCalculate) return;

        // OPTIMIZATION: Throttle "nearby enemies" check (every 10 frames)
        if (frameCountRef.current % 10 === 0) {
            let hasNearby = false;
            for (const u of e1.units.slice(0, 5)) { // Only check first 5 units
                const hgx = (u.pos.x / GRID_CELL_SIZE) | 0, hgy = (u.pos.y / GRID_CELL_SIZE) | 0;
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dy = -2; dy <= 2; dy++) {
                        const cell = spatialGridRef.current.get(gridKey(hgx + dx, hgy + dy));
                        if (cell && cell.some(n => {
                            let tId = n.entityId;
                            if (tId.startsWith('g_')) tId = garrisonMap.get(tId.substring(2))?.ownerId || tId;
                            return tId !== e1.id && tId !== 'neutral';
                        })) { hasNearby = true; break; }
                    }
                    if (hasNearby) break;
                }
                if (hasNearby) break;
            }
            e1.hasNearbyEnemies = hasNearby;
        }
        if (!e1.hasNearbyEnemies) return;

        // OPTIMIZATION: Only a few units perform melee checks to save CPU during clashes
        const swarmSize = e1.units.length;
        const meleeCount = swarmSize > 150 ? 6 : (swarmSize > 50 ? 8 : 10);
        const meleeUnits = e1.units.slice(0, meleeCount);
        
        meleeUnits.forEach((u1, ui1) => {
          if (unitsToRemove.has(u1.id)) return;
          const isFrontline = ui1 < 3; // Reduced frontline to 3
          // Aggressive throttling for non-frontline units (every 5th frame)
          if (!isFrontline && (frameCountRef.current + ui1) % 5 !== 0) return; 
          
          const gx = (u1.pos.x / GRID_CELL_SIZE) | 0;
          const gy = (u1.pos.y / GRID_CELL_SIZE) | 0;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const neighbors = spatialGridRef.current.get(gridKey(gx + dx, gy + dy));
              if (!neighbors) continue;
              for (const n of neighbors) {
                let tOwnerId = n.entityId;
                let tColor = '';
                const isTargetGarrison = n.entityId.startsWith('g_');
                if (isTargetGarrison) {
                  const gt = garrisonMap.get(n.entityId.substring(2));
                  if (!gt) continue;
                  tOwnerId = gt.ownerId; tColor = gt.color;
                } else {
                  const et = entityMap.get(n.entityId);
                  if (!et) continue;
                  tOwnerId = et.id; tColor = et.color;
                }
                if (tOwnerId === e1.id || unitsToRemove.has(n.unit.id)) continue;
                const d = getDistance(u1.pos, n.unit.pos);
                if (d > 45) continue;

                let targetObj = isTargetGarrison ? garrisonMap.get(n.entityId.substring(2)) : entityMap.get(n.entityId);
                if (!targetObj) continue;

                // NEW: Layer Isolation for Combat
                if (e1.isUnderground !== targetObj.isUnderground) continue;

                // FIXED: Only explicit attack triggers damage for players. AI still has auto-attack.
                const isAI = e1.type === 'ai';
                const isActive = e1.isAttacking && e1.attackTimer > 0 && (e1.swingKills || 0) < 5;
                const isAuto = isAI && !e1.isAttacking && (d < 30 && Math.random() < 0.01);

                if (isActive || isAuto) {
                  if (tOwnerId === myId && spawnProtectionRef.current) continue;
                  
                  const isCmdUnit = !isTargetGarrison && entityMap.get(n.entityId)?.units[0] === n.unit;
                  
                  // GLOBAL DAMAGE COOLDOWN FOR TARGET (Controlled by Attacker)
                  const now = Date.now();
                  // User requested 1-2 warriors per 1.5 seconds = 750ms cooldown
                  // If we hit a player, use 750ms. If we hit a garrison/AI, use 150ms for speed.
                  const isTargetPlayer = !isTargetGarrison && entityMap.get(n.entityId)?.type === 'player';
                  const cooldown = isTargetGarrison ? 10 : (isTargetPlayer ? 750 : (isCmdUnit ? 300 : 150));
                  if (now - (targetObj.lastDamageTime || 0) < cooldown) continue;

                  // Limit total hits per frame for the whole entity to prevent instant wipe
                  const entityHitKey = `hit_${e1.id}`;
                  if (!frameDamageMap.has(entityHitKey)) frameDamageMap.set(entityHitKey, 0);
                  
                  // INCREASED frameLimit for larger armies to feel smoother
                  let frameLimit = isTargetGarrison ? 4 : (isActive ? 4 : 1);
                  if (swarmSize > 100) frameLimit += 2; // Large army hits harder/faster

                  if (frameDamageMap.get(entityHitKey)! >= frameLimit) continue;

                  const damageVal = 100;
                  if (e1.id === myId && tOwnerId !== myId) {
                      socketRef.current?.emit('unit_hit', { 
                          roomId: currentRoomRef.current?.id, 
                          targetPlayerId: tOwnerId, 
                          damage: damageVal, 
                          attackerId: myId,
                          attackerName: nickname, // Always send our name
                          garrisonId: isTargetGarrison ? n.entityId.substring(2) : undefined,
                          isUndergroundAttack: e1.isUnderground // NEW: Sync underground status
                      });
                  }
                  
                  // Apply local damage
                  n.unit.hp -= damageVal;
                  targetObj.lastDamageTime = now;
                  frameDamageMap.set(entityHitKey, frameDamageMap.get(entityHitKey)! + 1);

                  if (n.unit.hp <= 0) {
                      // CRITICAL: VISUAL PREDICTION
                      // If I am the attacker, I remove the unit locally IMMEDIATELY so it feels smooth.
                      // If I am the victim, I remove it because it's my unit and I'm the authority.
                      // If it's a garrison or AI, we also remove it locally.
                      if (isTargetGarrison || tOwnerId === myId || !isMultiplayer || (e1.id === myId)) {
                          unitsToRemove.add(n.unit.id);
                      }
                      
                      e1.swingKills = (e1.swingKills || 0) + 1;
                      // "Hunting" reward: Killing neutrals (Holops) gives more than regular kills
                      const reward = (n.entityId === 'neutral') ? 15 : 5;
                      e1.akce += reward; 
                      if (e1.id === myId) { 
                        killsRef.current++; 
                        setKills(k => k + 1); 
                        setPlayerAkce(e1.akce); 
                        if (reward > 5) {
                          // Visual indicator for "Hunting" success
                          particlesRef.current.push({
                            pos: { ...n.unit.pos },
                            vel: { x: 0, y: -2 },
                            life: 1, maxLife: 1, color: '#fbbf24', type: 'text',
                            text: `+${reward} ${t.huntReward || 'HUNT'}`
                          });
                        }
                      }
                      createSlash(n.unit.pos.x, n.unit.pos.y, tColor);
                  }
                }
              }
            }
          }
        });
      });

      // Melee Combat (Garrisons)
      garrisonsRef.current.forEach(g => {
        if (g.units.length === 0) return;
        
        const isOwner = g.ownerId === myId || (socketRef.current?.id && g.ownerId === socketRef.current.id);
        const shouldCalculate = isOwner || (isMultiplayer && isHostRef.current && g.ownerId === 'ai');
        if (!shouldCalculate) return;

        // OPTIMIZATION: Throttle nearby enemies check for garrisons (every 10 frames)
        if (frameCountRef.current % 10 === 0) {
            let hasNearby = false;
            const hgx = (g.pos.x / GRID_CELL_SIZE) | 0, hgy = (g.pos.y / GRID_CELL_SIZE) | 0;
            for (let dx = -3; dx <= 3; dx++) {
                for (let dy = -3; dy <= 3; dy++) {
                    const cell = spatialGridRef.current.get(gridKey(hgx + dx, hgy + dy));
                    if (cell && cell.some(n => {
                        let tId = n.entityId;
                        if (tId.startsWith('g_')) tId = garrisonMap.get(tId.substring(2))?.ownerId || tId;
                        return tId !== g.ownerId && tId !== 'neutral';
                    })) { hasNearby = true; break; }
                }
                if (hasNearby) break;
            }
            g.hasNearbyEnemies = hasNearby;
        }
        if (!g.hasNearbyEnemies) {
            // Even if no nearby units, check for buildings to attack
            const meleeUnitsG = g.units.slice(0, 8);
            meleeUnitsG.forEach(u2 => {
                towersRef.current.forEach(t => {
                    if (t.ownerId === g.ownerId || t.color === g.color) return;
                    const d = getDistance(u2.pos, t.pos);
                    if (d < 80) {
                        const now = Date.now();
                        if (now - (t.lastInteractTime || 0) < 500) return;
                        t.lastInteractTime = now;
                        const oldHp = t.hp;
                        t.hp = Math.max(0, t.hp - 1);
                        createDust(t.pos.x, t.pos.y, t.color);
                        if (isOwner) {
                            socketRef.current?.emit('building_hit', { roomId: currentRoomRef.current?.id, buildingId: t.id, hp: t.hp });
                            if (t.hp <= 0 && oldHp > 0) socketRef.current?.emit('building_destroyed', { roomId: currentRoomRef.current?.id, buildingId: t.id });
                        }
                    }
                });
            });
            return;
        }

        // OPTIMIZATION: Only the first 8 units of a garrison perform melee checks (reduced from 12)
        const meleeUnitsG = g.units.slice(0, 8);
        meleeUnitsG.forEach((u2, ui2) => {
          if (unitsToRemove.has(u2.id)) return;
          if ((frameCountRef.current + ui2) % 3 !== 0) return; // Throttled checks
          
          // --- Unit vs Unit logic (existing) ---
          const gx = (u2.pos.x / GRID_CELL_SIZE) | 0;
          const gy = (u2.pos.y / GRID_CELL_SIZE) | 0;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const neighbors = spatialGridRef.current.get(gridKey(gx + dx, gy + dy));
              if (!neighbors) continue;
              for (const n of neighbors) {
                let tOwnerId = n.entityId;
                let tColor = '';
                const isTargetGarrison = n.entityId.startsWith('g_');
                if (isTargetGarrison) {
                  const gid = n.entityId.substring(2);
                  if (gid === g.id) continue;
                  const gt = garrisonMap.get(gid);
                  if (!gt) continue;
                  tOwnerId = gt.ownerId; tColor = gt.color;
                } else {
                  const et = entityMap.get(n.entityId);
                  if (!et) continue;
                  tOwnerId = et.id; tColor = et.color;
                }
                if (tOwnerId === g.ownerId || unitsToRemove.has(n.unit.id)) continue;
                const d = getDistance(u2.pos, n.unit.pos);
                if (d > 60) continue; // Engagement range for HUNT vs HUNT

                let targetObj = isTargetGarrison ? garrisonMap.get(n.entityId.substring(2)) : entityMap.get(n.entityId);
                if (!targetObj) continue;

                // NEW: Layer Isolation for Combat
                if (g.isUnderground !== targetObj.isUnderground) continue;

                const isTargetCmd = !isTargetGarrison && entityMap.get(n.entityId)?.units[0] === n.unit;
                const amIAttacker = g.ownerId === myId, amIDefender = tOwnerId === myId;
                
                const isAI = g.ownerId === 'ai';
                const isHoldMode = g.mode === 'HOLD';
                const hasEnemyInEngageRange = isHoldMode && g.hasNearbyEnemies;
                const isActive = (g.attackTimer > 0 || hasEnemyInEngageRange) && (g.swingKills || 0) < 3;
                const isAuto = isAI && !g.attackTimer && (d < 50 && Math.random() < 0.01);

                if (isActive || isAuto) {
                  if (amIDefender && spawnProtectionRef.current) continue;
                  const now = Date.now();
                  const isTargetPlayer = !isTargetGarrison && entityMap.get(n.entityId)?.type === 'player';
                  const cooldown = isTargetGarrison ? 20 : (isTargetPlayer ? 750 : (isTargetCmd ? 300 : 150));
                  if (now - (targetObj.lastDamageTime || 0) < cooldown) continue;

                  const garrisonHitKey = `hit_g_${g.id}`;
                  if (!frameDamageMap.has(garrisonHitKey)) frameDamageMap.set(garrisonHitKey, 0);
                  const frameLimit = isTargetGarrison ? 3 : (isActive ? 2 : 1);
                  if (frameDamageMap.get(garrisonHitKey)! >= frameLimit) continue;

                  if (isTargetGarrison) {
                      const targetG = targetObj as Garrison;
                      if (g.units.length < targetG.units.length && Math.random() < 0.3) continue;
                  }
                  if (!isTargetGarrison && Math.random() < 0.5) continue;
                  
                  const damageVal = 100; // Instakill
                  const isAttackerLocal = g.ownerId === myId;
                  const isAttackerHostAI = isHostRef.current && g.ownerId === 'ai';
                  
                  if (isAttackerLocal || isAttackerHostAI) {
                    if (!isTargetGarrison) {
                      socketRef.current?.emit('unit_hit', { 
                          roomId: currentRoomRef.current?.id, 
                          targetPlayerId: tOwnerId, 
                          damage: damageVal, 
                          attackerId: g.ownerId, 
                          attackerName: g.name || 'Garrison',
                          attackerGarrisonId: g.id,
                          isUndergroundAttack: g.isUnderground // NEW: Sync underground status
                      });
                    } else {
                      socketRef.current?.emit('garrison_hit', { 
                          roomId: currentRoomRef.current?.id, 
                          targetPlayerId: tOwnerId, 
                          damage: damageVal, 
                          garrisonId: n.entityId.substring(2), 
                          attackerId: g.ownerId, 
                          attackerGarrisonId: g.id,
                          isUndergroundAttack: g.isUnderground // NEW: Sync underground status
                      });
                    }
                  }
                  
                  n.unit.hp -= damageVal;
                  targetObj.lastDamageTime = now;
                  frameDamageMap.set(garrisonHitKey, (frameDamageMap.get(garrisonHitKey) || 0) + 1);

                  if (n.unit.hp <= 0) {
                      if (isTargetGarrison || tOwnerId === myId || !isMultiplayer || isAttackerLocal || isAttackerHostAI) {
                          unitsToRemove.add(n.unit.id);
                      }
                      g.swingKills = (g.swingKills || 0) + 1;
                      createSlash(n.unit.pos.x, n.unit.pos.y, tColor);
                  }
                }
              }
            }
          }

          // --- Unit vs Building logic (correctly placed here) ---
          towersRef.current.forEach(t => {
            if (t.ownerId === g.ownerId || t.color === g.color) return;
            const d = getDistance(u2.pos, t.pos);
            if (d < 80) {
              const now = Date.now();
              if (now - (t.lastInteractTime || 0) < 500) return;
              t.lastInteractTime = now;
              const oldHp = t.hp;
              t.hp = Math.max(0, t.hp - 1);
              createDust(t.pos.x, t.pos.y, t.color);
              if (isOwner) {
                socketRef.current?.emit('building_hit', { roomId: currentRoomRef.current?.id, buildingId: t.id, hp: t.hp });
                if (t.hp <= 0 && oldHp > 0) socketRef.current?.emit('building_destroyed', { roomId: currentRoomRef.current?.id, buildingId: t.id });
              }
            }
          });
        });
      });

      // Projectiles & AoE
      for (let i = projectilesRef.current.length - 1; i >= 0; i--) {
        const pr = projectilesRef.current[i];
        if (Math.random() < 0.6) particlesRef.current.push({ pos: { ...pr.pos }, vel: { x: (Math.random()-0.5)*2, y: (Math.random()-0.5)*2 }, life: 0.6, maxLife: 0.6, color: 'rgba(100,116,139,0.4)', type: 'dust' });
        if (pr.targetPos) {
          const a = Math.atan2(pr.targetPos.y - pr.pos.y, pr.targetPos.x - pr.pos.x);
          pr.vel.x = Math.cos(a) * PROJECTILE_SPEED; pr.vel.y = Math.sin(a) * PROJECTILE_SPEED;
        }
        pr.pos.x += pr.vel.x; pr.pos.y += pr.vel.y; pr.life -= 0.01;
        let impactP: Vector | null = null;
        if (pr.targetPos && getDistance(pr.pos, pr.targetPos) < PROJECTILE_SPEED) impactP = { ...pr.targetPos };
        else {
          for (const e of entitiesRef.current) {
            if (impactP || e.id === pr.ownerId || e.color === pr.color) continue;
            for (const u of e.units) if (getDistance(pr.pos, u.pos) < UNIT_RADIUS*2) { impactP = { ...pr.pos }; break; }
          }
          if (!impactP) for (const g of garrisonsRef.current) {
            if (impactP || g.ownerId === pr.ownerId || g.color === pr.color) continue;
            for (const u of g.units) if (getDistance(pr.pos, u.pos) < UNIT_RADIUS*2) { impactP = { ...pr.pos }; break; }
          }
          if (!impactP) for (const t of towersRef.current) {
            if (t.ownerId === pr.ownerId || t.color === pr.color) continue;
            if (getDistance(pr.pos, t.pos) < (t.type === 'wall' ? 30 : 50)) { impactP = { ...pr.pos }; break; }
          }
        }
        if (impactP) {
          // INCREASED AoE for Towers: Now deals fatal damage (100) to 2-3 units (radius 35)
          const aoeR = 35, aoeD = 100;
          particlesRef.current.push({ pos: { ...impactP }, vel: { x: 0, y: 0 }, life: 1, maxLife: 1, color: pr.color, type: 'ripple' });
          
          let hitCount = 0; 
          const maxHits = 3; // Buffed to hit up to 3 units
          
          entitiesRef.current.forEach(e => {
            if (e.id === pr.ownerId || e.color === pr.color || hitCount >= maxHits) return;
            for (let ui = e.units.length - 1; ui >= 0; ui--) {
              if (hitCount >= maxHits) break;
              if (getDistance(impactP as Vector, e.units[ui].pos) < aoeR) {
                e.units[ui].hp -= aoeD;
                hitCount++;
                if (e.units[ui].hp <= 0) {
                  // VISUAL PREDICTION: Remove locally if we are attacker or owner
                  if (ui !== 0 || e.id === myId || !isMultiplayer || pr.ownerId === myId) {
                      e.units.splice(ui, 1);
                  }
                  
                  createDust(impactP!.x, impactP!.y, e.color);
                  
                  // SERVER SYNC: Inform the target player they took damage
                  if (pr.ownerId === myId) {
                      socketRef.current?.emit('unit_hit', { 
                          roomId: currentRoomRef.current?.id, 
                          targetPlayerId: e.id, 
                          damage: aoeD,
                          unitIndex: ui,
                          attackerId: pr.ownerId,
                          attackerName: nickname
                      });
                  }
                  
                  // SERVER SYNC: Any client that detects a commander death should report it.
                  if (ui === 0 && e.units.length === 1) {
                  }
                } else if (pr.ownerId === myId) {
                   // Still sync partial damage
                   socketRef.current?.emit('unit_hit', { 
                       roomId: currentRoomRef.current?.id, 
                       targetPlayerId: e.id, 
                       damage: aoeD,
                       unitIndex: ui,
                       attackerId: pr.ownerId,
                       attackerName: nickname
                   });
                }
              }
            }
          });

          garrisonsRef.current.forEach(g => {
            if (g.ownerId === pr.ownerId || g.color === pr.color || hitCount >= maxHits) return;
            for (let ui = g.units.length - 1; ui >= 0; ui--) {
              if (hitCount >= maxHits) break;
              if (getDistance(impactP as Vector, g.units[ui].pos) < aoeR) {
                g.units[ui].hp -= aoeD;
                hitCount++;
                if (g.units[ui].hp <= 0) {
                  // VISUAL PREDICTION: Remove locally if we are attacker or owner
                  if (g.ownerId === myId || !isMultiplayer || pr.ownerId === myId) {
                      g.units.splice(ui, 1);
                  }
                  
                  createDust(impactP!.x, impactP!.y, g.color);
                  if (pr.ownerId === myId) {
                      socketRef.current?.emit('unit_hit', { 
                          roomId: currentRoomRef.current?.id, 
                          targetPlayerId: g.ownerId, 
                          damage: aoeD, 
                          garrisonId: g.id,
                          attackerId: pr.ownerId,
                          attackerName: pr.ownerId === myId ? nickname : 'Tower'
                      });
                  }
                }
              }
            }
          });

          // Buildings still take damage (5 hits to destroy a tower)
          towersRef.current.forEach(t => {
            if (t.ownerId === pr.ownerId || t.color === pr.color) return;
            // Increased damage radius to 60 to ensure it catches the tower that triggered impactP
            if (getDistance(impactP as Vector, t.pos) < 60) {
              const oldHp = t.hp; 
              
              // AUTHORITATIVE DAMAGE: Only the projectile owner (or host for AI/neutral) applies HP reduction
              const isAttacker = pr.ownerId === myId || (isHostRef.current && (pr.ownerId === 'ai' || !pr.ownerId));
              
              if (isAttacker) {
                  t.hp = Math.max(0, t.hp - 1); 
                  createDust(t.pos.x, t.pos.y, t.color);
                  
                  // Sync hit to everyone else
                  socketRef.current?.emit('building_hit', { 
                      roomId: currentRoomRef.current?.id, 
                      buildingId: t.id, 
                      hp: t.hp 
                  });
                  
                  if (t.hp <= 0 && oldHp > 0) {
                      socketRef.current?.emit('building_destroyed', { 
                          roomId: currentRoomRef.current?.id, 
                          buildingId: t.id 
                      });
                  }
              } else if (!isMultiplayer) {
                  // Fallback for single player mode
                  t.hp = Math.max(0, t.hp - 1);
                  createDust(t.pos.x, t.pos.y, t.color);
              }
              // Note: Remote players in multiplayer will receive 'remote_building_hit' 
              // and update their local t.hp accordingly, avoiding double subtraction.
            }
          });
          projectilesRef.current.splice(i, 1); continue;
        }
        if (pr.life <= 0) projectilesRef.current.splice(i, 1);
      }

      // Building Destruction Reward & Auto-Fire
      for (let i = towersRef.current.length - 1; i >= 0; i--) {
        const t = towersRef.current[i];
        if (t.hp <= 0) {
          // REMOVED: Enemy destruction reward (Per Sultan's request: "no money for broken enemy walls")
          for (let j = 0; j < 15; j++) particlesRef.current.push({ pos: { ...t.pos }, vel: { x: (Math.random()-0.5)*10, y: (Math.random()-0.5)*10 }, life: 1, maxLife: 1, color: t.color, type: 'tower_dust' });
          towersRef.current.splice(i, 1); continue;
        }
        
        // ONLY THE OWNER (or host for AI/neutral towers) triggers the shooting event
        const isOwner = t.ownerId === myId || (socketRef.current?.id && t.ownerId === socketRef.current.id);
        const shouldCalculate = isOwner || (!isMultiplayer && (t.ownerId === 'ai' || !t.ownerId)) || (isMultiplayer && isHostRef.current && (t.ownerId === 'ai' || !t.ownerId));
        if (!shouldCalculate) continue;

        if (t.type !== 'wall' && t.type !== 'gate' && t.type !== 'tunnel' && Date.now() - t.lastShot > 1500) {
          let nearestPos: Vector | null = null;
          let minD = 400;
          let currentTargetStillValid = false;

          // Check if current target is still valid (in range and alive)
          if (t.currentTargetId) {
            // Check entities
            const targetEnt = entitiesRef.current.find(e => e.id === t.currentTargetId);
            if (targetEnt && targetEnt.units.length > 0) {
              const d = getDistance(t.pos, targetEnt.units[0].pos);
              if (d < 400) {
                nearestPos = targetEnt.units[0].pos;
                currentTargetStillValid = true;
              }
            }
            
            // Check garrisons if no entity found
            if (!currentTargetStillValid) {
              const targetG = garrisonsRef.current.find(g => g.id === t.currentTargetId);
              if (targetG && targetG.units.length > 0) {
                const d = getDistance(t.pos, targetG.pos);
                if (d < 400) {
                  nearestPos = targetG.pos;
                  currentTargetStillValid = true;
                }
              }
            }

            // Check towers if no entity or garrison found
            if (!currentTargetStillValid) {
              const targetT = towersRef.current.find(tr => tr.id === t.currentTargetId);
              if (targetT && targetT.hp > 0) {
                const d = getDistance(t.pos, targetT.pos);
                if (d < 400) {
                  nearestPos = targetT.pos;
                  currentTargetStillValid = true;
                }
              }
            }
          }

          if (!currentTargetStillValid) {
            t.currentTargetId = null;
            // Find NEW target if current is invalid
            // 1. Target Enemy Units
            entitiesRef.current.forEach(e => {
              if (e.id === t.ownerId || e.faction === t.faction || e.isUnderground) return; // NEW: Layer isolation
              e.units.forEach(u => { 
                  const d = getDistance(t.pos, u.pos); 
                  if (d < minD) { minD = d; nearestPos = u.pos; t.currentTargetId = e.id; } 
              });
            });

            // 2. Target Enemy Garrisons
            garrisonsRef.current.forEach(g => {
              if (g.ownerId === t.ownerId || g.color === t.color || g.isUnderground) return; // NEW: Layer isolation
              const d = getDistance(t.pos, g.pos);
              if (d < minD) { minD = d; nearestPos = g.pos; t.currentTargetId = g.id; }
            });

            // 3. Target Enemy Towers
            towersRef.current.forEach(targetTower => {
              if (t.id === targetTower.id) return;
              if (targetTower.ownerId === t.ownerId || targetTower.color === t.color) return;
              if (targetTower.type === 'wall' || targetTower.type === 'gate') return;
              
              const d = getDistance(t.pos, targetTower.pos);
              if (d < minD) { minD = d; nearestPos = targetTower.pos; t.currentTargetId = targetTower.id; }
            });
          }

          if (nearestPos) {
            t.lastShot = Date.now(); 
            fireProjectile(t.ownerId, t.pos, nearestPos, t.color, t.empireId);
          }
        }
      }

      // Building Attacks (Armies/Garrisons)
      entitiesRef.current.forEach(e => {
        if (e.units.length === 0 || e.hasHitInCurrentSwing) return;
        towersRef.current.forEach(t => {
          if (t.ownerId === e.id || t.faction === e.faction || (t.type as any) === 'tunnel') return;
          if (getDistance(e.units[0].pos, t.pos) < 60 && e.isAttacking && e.attackTimer < 250) {
            const oldHp = t.hp; t.hp = Math.max(0, t.hp - 1); createDust(t.pos.x, t.pos.y, t.color); e.hasHitInCurrentSwing = true;
            if (t.hp <= 0 && oldHp > 0 && (e.id === myId || isHostRef.current)) socketRef.current?.emit('building_destroyed', { roomId: currentRoomRef.current?.id, buildingId: t.id });
          }
        });
      });
      // --- Village Capture & Income Logic ---
      if (frameCountRef.current % 10 === 0) {
        // Delayed village spawn logic (after 60 seconds)
        if (startTimeRef.current && isHostRef.current && gameMapRef.current.futureVillages && gameMapRef.current.futureVillages.length > 0) {
          const gameTime = Date.now() - startTimeRef.current;
          if (gameTime > 60000) { // 60 seconds
            const newVillage = gameMapRef.current.futureVillages.shift();
            if (newVillage) {
              gameMapRef.current.villages.push(newVillage);
              socketRef.current?.emit('village_spawned', { 
                roomId: currentRoomRef.current?.id, 
                village: newVillage 
              });
              // Show notification effect in center
              createDust(newVillage.pos.x, newVillage.pos.y, '#fbbf24');
            }
          }
        }

        gameMapRef.current.villages.forEach(v => {
          const unitsInRadius: Record<string, number> = {}; // empireId -> count
          
          entitiesRef.current.forEach(ent => {
            if (ent.units.length === 0 || ent.isUnderground) return; // NEW: Underground can't capture
            ent.units.forEach(u => {
              if (getDistance(u.pos, v.pos) < v.radius) {
                const emp = ent.empireId || 'neutral';
                unitsInRadius[emp] = (unitsInRadius[emp] || 0) + 1;
              }
            });
          });
          
          garrisonsRef.current.forEach(g => {
            if (g.units.length === 0 || g.isUnderground) return; // NEW: Underground can't capture
            g.units.forEach(u => {
              if (getDistance(u.pos, v.pos) < v.radius) {
                const emp = g.empireId || 'neutral';
                unitsInRadius[emp] = (unitsInRadius[emp] || 0) + 1;
              }
            });
          });

          const factions = Object.keys(unitsInRadius);
          if (factions.length === 1) {
            const f = factions[0];
            const unitCount = unitsInRadius[f];
            const captureSpeed = Math.min(5, 1 + Math.floor(unitCount / 10)); // Faster with more units

            if (v.ownerId && v.ownerId !== f) {
              // PHASE 1: Neutralize enemy village
              v.captureProgress -= captureSpeed;
              if (v.captureProgress <= 0) {
                v.ownerId = null;
                v.captureProgress = 0;
                v.color = '#78350f'; // Reset to neutral
              }
            } else if (v.ownerId !== f) {
              // PHASE 2: Capture neutral village
              v.captureProgress += captureSpeed;
              if (v.captureProgress >= 100) {
                v.ownerId = f;
                v.captureProgress = 100;
                v.color = EMPIRE_COLORS[f as keyof typeof EMPIRE_COLORS] || '#78350f';
              }
            } else if (v.captureProgress < 100) {
              // Restore progress if owner is present
              v.captureProgress = Math.min(100, v.captureProgress + captureSpeed);
            }
          } else if (factions.length === 0) {
            // Passive decay/restoration is disabled to keep it tactical
          }

          if (v.ownerId && Date.now() - v.lastIncomeTime > 5000) {
            v.lastIncomeTime = Date.now();
            if (v.ownerId === initialEmpire.id && playerRef.current) {
              playerRef.current.akce += 30; // FIXED: Increased village income
              setPlayerAkce(playerRef.current.akce);
              particlesRef.current.push({
                pos: { x: v.pos.x, y: v.pos.y - 40 },
                vel: { x: 0, y: -1 },
                life: 1.5,
                maxLife: 1.5,
                color: '#fbbf24',
                type: 'text',
                text: `+30 ${t.villageTax}`
              });
            }
          }
        });
      }

      // --- Caravan Movement & Logic (Peaceful Escort) ---
      const playerCount = entitiesRef.current.filter(e => e.type === 'player').length;
      // 1 for 2-3 players, 2 for 4-5, 3 for 6-7... (Math.floor(pCount/2))
      const maxCaravans = Math.max(1, Math.floor(playerCount / 2));
      
      if (isHostRef.current && frameCountRef.current % 1200 === 0 && caravansRef.current.length < maxCaravans) {
        const size = worldSizeRef.current;
        const edge = Math.floor(Math.random() * 4);
        let start = { x: 0, y: 0 }, target = { x: 0, y: 0 };
        if (edge === 0) { start = { x: Math.random()*size, y: 0 }; target = { x: Math.random()*size, y: size }; }
        else if (edge === 1) { start = { x: size, y: Math.random()*size }; target = { x: 0, y: Math.random()*size }; }
        else if (edge === 2) { start = { x: Math.random()*size, y: size }; target = { x: Math.random()*size, y: 0 }; }
        else { start = { x: 0, y: Math.random()*size }; target = { x: size, y: Math.random()*size }; }
        
        caravansRef.current.push({
          id: 'caravan_' + Date.now(),
          pos: start,
          targetPos: target,
          speed: 1.0,
          color: '#fbbf24',
          isReal: true,
          escortOwnerId: null,
          escortTimer: 5,
          lastAkceTime: Date.now(),
          outOfCircleTime: 0
        });
      }

      // --- CARAVAN REWRITE (Peaceful Escort) ---
      for (let i = caravansRef.current.length - 1; i >= 0; i--) {
        const c = caravansRef.current[i];
        const sid = socketRef.current?.id || myIdRef.current;
        
        // Host-Authoritative Logic
        if (isHostRef.current) {
            // 1. Movement
            const ang = Math.atan2(c.targetPos.y - c.pos.y, c.targetPos.x - c.pos.x);
            c.pos.x += Math.cos(ang) * c.speed;
            c.pos.y += Math.sin(ang) * c.speed;

            if (getDistance(c.pos, c.targetPos) < 50) {
              caravansRef.current.splice(i, 1);
              continue;
            }

            // 2. Escort Contract Management
            if (c.escortOwnerId) {
                const owner = entitiesRef.current.find(e => e.id === c.escortOwnerId) || (c.escortOwnerId === sid ? playerRef.current : null);
                const head = owner?.units[0];
                const d = head ? getDistance(c.pos, head.pos) : 9999;
                
                if (d > 250) { // ESCORT_RADIUS
                    c.outOfCircleTime = (c.outOfCircleTime || 0) + dt;
                    if (c.outOfCircleTime > 3000) {
                        c.escortOwnerId = null;
                        c.escortTimer = 5;
                        c.outOfCircleTime = 0;
                    }
                } else {
                    c.outOfCircleTime = 0;
                    // Timer Ticking for others' visuals
                    if (c.escortOwnerId !== sid) {
                        const now = Date.now();
                        if (now - (c.lastAkceTime || 0) >= 1000) {
                            c.lastAkceTime = now;
                            c.escortTimer = (c.escortTimer || 5) - 1;
                            if (c.escortTimer <= 0) c.escortTimer = 5;
                        }
                    }
                }
            }
        } else {
            // Clients: Smooth Interpolation
            if (c.lastSyncPos) {
                const lerpFactor = 1 - Math.exp(-0.02 * dt);
                c.pos.x += (c.lastSyncPos.x - c.pos.x) * lerpFactor;
                c.pos.y += (c.lastSyncPos.y - c.pos.y) * lerpFactor;
            }
        }

        // 3. Client-Authoritative Timer & Reward
        if (c.escortOwnerId === sid && playerRef.current) {
            const head = playerRef.current.units[0];
            const d = head ? getDistance(c.pos, head.pos) : 9999;
            if (d <= 250) {
                const now = Date.now();
                if (now - (c.lastAkceTime || 0) >= 1000) {
                    c.lastAkceTime = now;
                    c.escortTimer = (c.escortTimer || 5) - 1;
                    if (c.escortTimer <= 0) {
                        c.escortTimer = 5;
                        playerRef.current.akce += 20;
                        setPlayerAkce(playerRef.current.akce);
                        
                        particlesRef.current.push({
                            pos: { x: playerRef.current.units[0].pos.x, y: playerRef.current.units[0].pos.y - 40 },
                            vel: { x: 0, y: -2 },
                            life: 1.5,
                            maxLife: 1.5,
                            color: '#fbbf24',
                            type: 'text',
                            text: `+20 Akçe`
                        });
                    }
                }
            }
        }

        // 4. Input Handling (Local Request)
        if (!c.escortOwnerId) {
            const pHead = playerRef.current?.units[0];
            const isFPressed = keysRef.current['f'] || keysRef.current['F'] || keysRef.current['KeyF'];
            if (pHead && !playerRef.current?.isUnderground && getDistance(c.pos, pHead.pos) < 250 && isFPressed) {
                const now = Date.now();
                if (now - (c.lastAkceTime || 0) > 1000) { // Simple debounce
                    c.lastAkceTime = now;
                    socketRef.current?.emit('sync_data', { 
                        roomId: currentRoomRef.current?.id, 
                        caravanEscortRequest: c.id 
                    });
                    createDust(c.pos.x, c.pos.y, '#fbbf24');
                    // OPTIMISTIC UPDATE
                    if (isHostRef.current) {
                        c.escortOwnerId = sid;
                        c.escortTimer = 5;
                        c.lastAkceTime = Date.now();
                        c.outOfCircleTime = 0;
                    }
                }
            }
        }
      }
    }

    // --- GATE INTERACTION (OWNER ONLY) ---
    const isFPressed = keysRef.current['f'] || keysRef.current['F'] || keysRef.current['KeyF'];
    const pPos = playerRef.current?.units[0]?.pos;
    if (isFPressed && pPos && !playerRef.current?.isUnderground && Date.now() - lastGateToggleTime.current > 500) {
        // Ownership check: matches ID or player's empire color/faction
        const nearbyGate = towersRef.current.find(t => 
            t.type === 'gate' && 
            (t.ownerId === myId || t.color === playerRef.current?.color || t.faction === playerRef.current?.color) && 
            getDistance(t.pos, pPos) < 150
        );
        
        if (nearbyGate) {
            lastGateToggleTime.current = Date.now();
            nearbyGate.isOpen = !nearbyGate.isOpen;
            
            // Visual feedback
            createDust(nearbyGate.pos.x, nearbyGate.pos.y, '#fbbf24');
            
            // Sync with server
            socketRef.current?.emit('toggle_gate', { 
                roomId: currentRoomRef.current?.id, 
                buildingId: nearbyGate.id, 
                isOpen: nearbyGate.isOpen 
            });
        }
    }

    // --- GARRISON INTERACTION (OWNER ONLY) ---
    if (isFPressed && pPos) {
        const nearbyGarrison = garrisonsRef.current.find(g => 
            g.ownerId === myId && 
            g.isUnderground === playerRef.current?.isUnderground && // NEW: Layer must match
            getDistance(g.pos, pPos) < 150
        );
        
        if (nearbyGarrison && Date.now() - (nearbyGarrison.lastInteractTime || 0) > 1000) {
            nearbyGarrison.lastInteractTime = Date.now();
            
            // Rejoin logic
            if (playerRef.current) {
                playerRef.current.units.push(...nearbyGarrison.units);
                
                // Remove from local
                const gIdx = garrisonsRef.current.findIndex(g => g.id === nearbyGarrison.id);
                if (gIdx !== -1) garrisonsRef.current.splice(gIdx, 1);
                
                recentlyDestroyedGarrisons.current.set(nearbyGarrison.id, Date.now());
                setPlayerGarrisons([...garrisonsRef.current.filter(xg => xg.ownerId === myId)]);
                
                // Visual
                createDust(nearbyGarrison.pos.x, nearbyGarrison.pos.y, nearbyGarrison.color);
                
                // Sync
                socketRef.current?.emit('garrison_destroyed', { 
                    roomId: currentRoomRef.current?.id, 
                    garrisonId: nearbyGarrison.id, 
                    ownerId: myId 
                });
                
                // Force an immediate state sync for units
                lastSyncTimeRef.current = 0; 
            }
        }
    }

    // 6. Final Cleanups
    if (unitsToRemove.size > 0) {
        entitiesRef.current.forEach(ent => {
          const before = ent.units.length;
          ent.units = ent.units.filter(u => !unitsToRemove.has(u.id));
          
          if (before !== ent.units.length && ent.id === myId) {
              // Optimization: Only update score state if significant or throttled
              const now = Date.now();
              if (now - lastUIUpdateTimeRef.current > 200 || ent.units.length === 0) {
                  setScore(ent.units.length);
                  // Note: we don't update lastUIUpdateTimeRef here to allow leaderboard to update too
              }
              
          }
        });
    }
    garrisonsRef.current.forEach(g => { g.units = g.units.filter(u => !unitsToRemove.has(u.id)); });
    neutralsRef.current = neutralsRef.current.filter(n => !unitsToRemove.has(n.id));
    unitsToRemove.clear();

    const emptyG = garrisonsRef.current.filter(g => g.units.length === 0);
    if (emptyG.length > 0) {
      emptyG.forEach(g => {
        recentlyDestroyedGarrisons.current.set(g.id, Date.now());
        // Emit destroyed event regardless of ownership to ensure sync
        // If we killed a remote garrison, the owner MUST know so they stop hitting us
        socketRef.current?.emit('garrison_destroyed', { 
            roomId: currentRoomRef.current?.id, 
            garrisonId: g.id, 
            ownerId: g.ownerId 
        });
      });
      garrisonsRef.current = garrisonsRef.current.filter(g => g.units.length > 0);
      setPlayerGarrisons([...garrisonsRef.current.filter(g => g.ownerId === myId)]);
    }

    // Build fast lookup map for buildings (once per frame for rendering logic)
    buildingMapRef.current.clear();
    towersRef.current.forEach(t => {
        const gx = Math.round(t.pos.x / GRID_SIZE);
        const gy = Math.round(t.pos.y / GRID_SIZE);
        buildingMapRef.current.set(`${gx}_${gy}`, t);
    });

    // Particles update for everyone
    for (let i = particlesRef.current.length - 1; i >= 0; i--) {
      const pt = particlesRef.current[i]; pt.pos.x += pt.vel.x; pt.pos.y += pt.vel.y; pt.life -= 0.015;
      if (pt.life <= 0) particlesRef.current.splice(i, 1);
    }

    // Update Stats & Leaderboard
    if (p.units.length > maxArmyRef.current) maxArmyRef.current = p.units.length;
    const allAlivePlayers = entitiesRef.current.filter(e => e.type === 'player' && e.units.length > 0);
    
    // Optimization: Throttle UI updates for leaderboard and active players (every 500ms)
    const now_ui = Date.now();
    if (now_ui - lastUIUpdateTimeRef.current > 500) {
        setLeaderboard(allAlivePlayers.map(e => ({ name: e.name, score: e.units.length })).sort((a, b) => b.score - a.score).slice(0, 5));
        setActivePlayers(allAlivePlayers.length);
        lastUIUpdateTimeRef.current = now_ui;
    }

    if (isMultiplayer && p && socketRef.current && currentRoomRef.current && (Date.now() - lastSyncTimeRef.current > CLIENT_SYNC_INTERVAL) && !isSpectatorRef.current) {
      lastSyncTimeRef.current = Date.now();
      
      // SYNC GARRISONS: Owner sends their own, Host sends AI-owned
      const garrisonsToSync = garrisonsRef.current
        .filter(g => g.ownerId === myId || (isHostRef.current && g.ownerId === 'ai'))
        .map(g => ({ 
          id: g.id, 
          pos: g.pos, 
          mode: g.mode, 
          targetPos: g.targetPos, // SYNC TARGET POS FOR SMOOTH PREDICTION
          unitCount: g.units.length, 
          empireId: g.empireId, 
          color: g.color, 
          attackTimer: g.attackTimer,
          isUnderground: g.isUnderground // NEW: Layer sync
        }));

      // SYNC CARAVANS: Only host sends the caravan state to everyone
      const caravansToSync = isHostRef.current ? caravansRef.current.map(c => ({
          id: c.id,
          pos: c.pos,
          targetPos: c.targetPos,
          escortOwnerId: c.escortOwnerId,
          escortTimer: c.escortTimer,
          outOfCircleTime: c.outOfCircleTime,
          lastSyncPos: c.pos // Added current pos as lastSyncPos for others
      })) : undefined;

      socketRef.current.emit('sync_data', {
        roomId: currentRoomRef.current.id, 
        id: myId, 
        x: p.units[0]?.pos.x || 0, 
        y: p.units[0]?.pos.y || 0, 
        rotation: p.facingAngle, 
        faction: p.faction, 
        empireId: p.empireId, 
        unitCount: Math.max(0, p.units.length - 1), 
        akce: p.akce, 
        hp: p.units[0]?.hp || COMMANDER_MAX_HP, 
        isAttacking: p.isAttacking, 
        isDashing: p.isDashing, 
        isUnderground: p.isUnderground ?? false, 
        equippedItem: p.equippedItem, // NEW: Sync equipped item
        name: nickname, 
        recruitedIds: Array.from(pendingRecruitsRef.current), 
        garrisons: garrisonsToSync, 
        caravans: caravansToSync
      });
      pendingRecruitsRef.current.clear();
    }

    frameId.current = requestAnimationFrame(update);
    } catch (err) {
        console.error("CRITICAL ENGINE ERROR:", err);
        // Recovery: ensure next frame is still scheduled
        frameId.current = requestAnimationFrame(update);
    }
  }, [gameState, saveFinalStats, activePlayers, splitSwarm, isMultiplayer, isHost, myId, playerAkce, score, kills, totalRecruitsMatch, nickname]);

  useEffect(() => { 
    if (gameState === 'GAME_ACTIVE' || gameState === 'LOBBY_WAITING') {
      frameId.current = requestAnimationFrame(update); 
    }
    return () => cancelAnimationFrame(frameId.current); 
  }, [gameState, update]);

  useEffect(() => {
    const cv = canvasRef.current, ctx = cv?.getContext('2d'); if (!cv || !ctx) return;

    const VISION_RADIUS = 900; // Increased radius for smoother gameplay
    const getDistanceSimple = (x1: number, y1: number, x2: number, y2: number) => {
      return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    };

    // Pre-calculated view bounds for faster culling
    const viewBounds = {
      left: 0, right: 0, top: 0, bottom: 0
    };

    const isPointInView = (x: number, y: number, padding: number = 200) => {
      return (
        x >= viewBounds.left - padding &&
        x <= viewBounds.right + padding &&
        y >= viewBounds.top - padding &&
        y <= viewBounds.bottom + padding
      );
    };

    const render = () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      
      const zoom = cameraZoomRef.current;
      const cx = cameraRef.current.x, cy = cameraRef.current.y;
      
      // Update view bounds for the current frame
      const invZoom = 1 / zoom;
      const halfW = (w / 2) * invZoom;
      const halfH = (h / 2) * invZoom;
      viewBounds.left = cx - halfW;
      viewBounds.right = cx + halfW;
      viewBounds.top = cy - halfH;
      viewBounds.bottom = cy + halfH;

      // 1. Clear Canvas & Draw the "Out of Bounds" Void
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0f172a'; // Dark slate for outside the map
      ctx.fillRect(0, 0, w, h);

      ctx.save(); // SAVE CAMERA STATE

      // 2. Apply Zoom & Camera Pan
      const currentWorldSize = worldSizeRef.current;

      ctx.translate(w / 2, h / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-w / 2, -h / 2);
      ctx.translate(w / 2 - cx, h / 2 - cy);

      // 3. Draw the Actual Map Grass
      // Optimization: Only clear the visible map area or use a simple background
      ctx.fillStyle = '#2d6a4f';
      ctx.fillRect(0, 0, currentWorldSize, currentWorldSize);
      
      if (shakeRef.current > 0) {
        ctx.translate((Math.random()-0.5)*shakeRef.current, (Math.random()-0.5)*shakeRef.current);
      }
      
      // Draw map borders
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 10;
      ctx.strokeRect(0, 0, currentWorldSize, currentWorldSize);

      const localHeadPos = playerRef.current?.units[0]?.pos;

      // Protection Circles (Drawn below everything)
      caravansRef.current.forEach(c => {
        const sid = socketRef.current?.id || myIdRef.current;
        if (c.escortOwnerId === sid) {
           const ESCORT_RADIUS = 250;
           ctx.save();
           ctx.translate(c.pos.x, c.pos.y);
           ctx.beginPath();
           ctx.arc(0, 0, ESCORT_RADIUS, 0, Math.PI * 2);
           
           const isWarning = (c.outOfCircleTime || 0) > 0;
           ctx.strokeStyle = isWarning ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.4)';
           ctx.lineWidth = 6;
           ctx.setLineDash([15, 10]);
           ctx.stroke();
           ctx.setLineDash([]);
           ctx.fillStyle = isWarning ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)';
           ctx.fill();
           ctx.restore();
        }
      });

      towersRef.current.forEach(t => {
        if (!isPointInView(t.pos.x, t.pos.y, 150)) return;
        
        const p = playerRef.current;
        const isTunnel = (t.type as any) === 'tunnel';

        // NEW: Layer Isolation for buildings
        // If underground, ONLY draw tunnels. Hide walls/gates/towers.
        if (p?.isUnderground && !isTunnel) return;

        // Fog of War: Hide enemy buildings if too far (unless spectator)
        if (!isSpectatorRef.current && localHeadPos) {
          const d = getDistanceSimple(localHeadPos.x, localHeadPos.y, t.pos.x, t.pos.y);
          if (d > VISION_RADIUS && t.ownerId !== myId) return;
        }

        ctx.save();
        ctx.translate(t.pos.x, t.pos.y);
        
        if (isTunnel) {
            // --- DRAW TUNNEL (HOLE) ---
            ctx.fillStyle = '#3e2723'; // Dark dirt
            ctx.beginPath(); ctx.ellipse(0, 0, 40, 25, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#4e342e'; // Lighter dirt detail
            ctx.beginPath(); ctx.ellipse(0, 0, 25, 15, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(0,0,0,0.7)'; // Hole
            ctx.beginPath(); ctx.ellipse(0, 0, 15, 8, 0, 0, Math.PI * 2); ctx.fill();

            // Interaction Hint (Match Gate Style)
            if (localHeadPos && gameState === 'GAME_ACTIVE') {
              const dist = getDistanceSimple(localHeadPos.x, localHeadPos.y, t.pos.x, t.pos.y);
              if (dist < 300) {
                const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
                const isOwner = t.ownerId === myId || t.ownerId === playerRef.current?.id;
                
                ctx.save();
                // 1. [F] ENTER/EXIT Bubble
                ctx.fillStyle = 'rgba(0,0,0,0.85)';
                ctx.beginPath();
                ctx.rect(-45, -85, 90, 24);
                ctx.fill();
                ctx.strokeStyle = '#fbbf24';
                ctx.lineWidth = 1;
                ctx.stroke();

                if (isMobile) {
                  ctx.fillStyle = '#fbbf24';
                  ctx.font = 'bold 10px Inter, sans-serif';
                  ctx.textAlign = 'center';
                  ctx.fillText('TAP TO ' + (p?.isUnderground ? 'EXIT' : 'ENTER'), 0, -68);
                } else {
                  ctx.fillStyle = '#fbbf24';
                  ctx.font = 'bold 14px Inter, sans-serif';
                  ctx.textAlign = 'center';
                  ctx.fillText('F', -30, -68);
                  ctx.fillStyle = '#ffffff';
                  ctx.font = '10px Inter, sans-serif';
                  ctx.textAlign = 'left';
                  ctx.fillText(p?.isUnderground ? 'EXIT' : 'ENTER', -15, -68);
                }

                // 2. [R] HIDE Bubble (Only for owner)
                if (isOwner) {
                  ctx.translate(0, -30);
                  ctx.fillStyle = 'rgba(0,0,0,0.85)';
                  ctx.beginPath();
                  ctx.rect(-45, -85, 90, 24);
                  ctx.fill();
                  ctx.strokeStyle = '#ef4444';
                  ctx.lineWidth = 1;
                  ctx.stroke();

                  if (isMobile) {
                    ctx.fillStyle = '#ef4444';
                    ctx.font = 'bold 10px Inter, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('TAP TO HIDE', 0, -68);
                  } else {
                    ctx.fillStyle = '#ef4444';
                    ctx.font = 'bold 14px Inter, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('R', -30, -68);
                    ctx.fillStyle = '#ffffff';
                    ctx.font = '10px Inter, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText('HIDE', -15, -68);
                  }
                }
                ctx.restore();
              }
            }
            ctx.restore();
            return; // Skip the rest of building drawing for tunnels
        }

        // Auto-detect empire style if missing or neutral (rendering safety)
        let renderEmpireId = t.empireId;
        if (!renderEmpireId || renderEmpireId === 'neutral') {
          const owner = entitiesRef.current.find(e => e.id === t.ownerId || e.color === t.color);
          if (owner) renderEmpireId = owner.empireId;
        }

        if (t.type === 'wall') {
            const gx = Math.round(t.pos.x / GRID_SIZE);
            const gy = Math.round(t.pos.y / GRID_SIZE);
            const n_t = buildingMapRef.current.get(`${gx}_${gy-1}`);
            const n_b = buildingMapRef.current.get(`${gx}_${gy+1}`);
            const n_l = buildingMapRef.current.get(`${gx-1}_${gy}`);
            const n_r = buildingMapRef.current.get(`${gx+1}_${gy}`);

            if (t.rotation) ctx.rotate(t.rotation * Math.PI / 180);

            const isH = (t.rotation || 0) === 0;
            const hasPrev = isH ? (n_l && (n_l.type==='wall' || n_l.type==='gate')) : (n_t && (n_t.type==='wall' || n_t.type==='gate'));
            const hasNext = isH ? (n_r && (n_r.type==='wall' || n_r.type==='gate')) : (n_b && (n_b.type==='wall' || n_b.type==='gate'));

            // Exact boundaries: 35 is grid edge, 55 is overlap into neighbor
            const drawStart = hasPrev ? -55 : -35;
            const drawEnd = hasNext ? 55 : 35;
            const drawLen = drawEnd - drawStart;

            if (renderEmpireId === 'rim') {
              // --- Russian Palisade (Засека) ---
              ctx.fillStyle = '#4e342e';
              ctx.fillRect(drawStart, -15, drawLen, 30);
              
              // Log Pattern
              ctx.fillStyle = '#5d4037';
              const logWidth = 10;
              const startLog = Math.floor(drawStart / logWidth);
              const endLog = Math.ceil(drawEnd / logWidth);
              for(let i = startLog; i < endLog; i++) {
                const x = i * logWidth;
                const h = 20 + Math.sin(i * 1.5) * 5;
                ctx.beginPath();
                ctx.moveTo(x + 1, -15);
                ctx.lineTo(x + 5, -15 - h);
                ctx.lineTo(x + 9, -15);
                ctx.fill();
              }
              // Iron Reinforcement Bands
              ctx.fillStyle = '#334155';
              ctx.fillRect(drawStart, -5, drawLen, 4);
              ctx.fillRect(drawStart, 10, drawLen, 4);
            } else if (renderEmpireId === 'fim') {
              // --- French Bastion Wall (Stone & Iron) ---
              ctx.fillStyle = '#cbd5e1';
              ctx.fillRect(drawStart, -18, drawLen, 36);
              // Stone texture (repeating every 14px)
              ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1;
              const step = 14;
              const sIdx = Math.floor(drawStart / step);
              const eIdx = Math.ceil(drawEnd / step);
              for(let i = sIdx; i <= eIdx; i++) {
                ctx.beginPath(); ctx.moveTo(i*step, -18); ctx.lineTo(i*step, 18); ctx.stroke();
              }
              ctx.beginPath(); ctx.moveTo(drawStart, 0); ctx.lineTo(drawEnd, 0); ctx.stroke();
              // Golden Top Railing
              ctx.fillStyle = '#fbbf24';
              ctx.fillRect(drawStart, -22, drawLen, 4);
            } else {
              // --- Ottoman Sandstone Wall ---
              ctx.fillStyle = '#d4a373';
              ctx.fillRect(drawStart, -15, drawLen, 35);
              // Islamic Geometric Pattern
              ctx.strokeStyle = '#bc8a5f'; ctx.lineWidth = 1.5;
              const step = 15;
              const sIdx = Math.floor(drawStart / step);
              const eIdx = Math.ceil(drawEnd / step);
              for(let i = sIdx; i <= eIdx; i++) {
                ctx.save(); ctx.translate(i*step, 5); ctx.rotate(Math.PI/4); ctx.strokeRect(-4, -4, 8, 8); ctx.restore();
              }
              // Battlements
              ctx.fillStyle = '#bc8a5f';
              const bStep = 20;
              const bsIdx = Math.floor(drawStart / bStep);
              const beIdx = Math.ceil(drawEnd / bStep);
              for(let i = bsIdx; i < beIdx; i++) {
                ctx.fillRect(i*bStep + 3, -25, 14, 10);
              }
            }
            
            // Faction Accent (Always centered)
            ctx.fillStyle = t.color;
            ctx.fillRect(-10, 5, 20, 5);

            // DRAW JOINTS FOR PERPENDICULAR CORNERS (Bridge the 20px gap)
            ctx.rotate(-(t.rotation || 0) * Math.PI / 180); // Back to world space
            const jointColor = renderEmpireId === 'rim' ? '#4e342e' : (renderEmpireId === 'fim' ? '#cbd5e1' : '#d4a373');
            const thickness = renderEmpireId === 'fim' ? 36 : 30;
            const halfThick = thickness / 2;

            if (isH) {
              if (n_t && (n_t.type === 'wall' || n_t.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(-halfThick, -35, thickness, 20); // Bridge Up (15 to 35)
              }
              if (n_b && (n_b.type === 'wall' || n_b.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(-halfThick, 15, thickness, 20); // Bridge Down (15 to 35)
              }
            } else {
              if (n_l && (n_l.type === 'wall' || n_l.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(-35, -halfThick, 20, thickness); // Bridge Left
              }
              if (n_r && (n_r.type === 'wall' || n_r.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(15, -halfThick, 20, thickness); // Bridge Right
              }
            }
            ctx.rotate((t.rotation || 0) * Math.PI / 180); // Restore rotation for HUD

            // Health Bar (Wall) - Fixed clamping and added Shield Icon
            ctx.rotate(-(t.rotation || 0) * Math.PI / 180); // Un-rotate for HUD
            const maxHp = (t.type === 'tower') ? TOWER_MAX_HP : (t.type === 'gate' ? GATE_MAX_HP : WALL_MAX_HP);
            if (t.hp < maxHp - 0.01) { // Show immediately after first hit
              const bWidth = 50;
              const hRatio = Math.max(0, Math.min(1, t.hp / maxHp));
              const clampedW = Math.max(0, Math.min(bWidth, bWidth * hRatio));
              ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-25, -45, bWidth, 6);
              ctx.fillStyle = '#ef4444'; ctx.fillRect(-25, -45, bWidth, 6);
              ctx.fillStyle = '#22c55e'; ctx.fillRect(-25, -45, clampedW, 6);
              
              // HP TEXT (e.g. "9 / 10")
              ctx.font = 'bold 12px Inter, sans-serif';
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.shadowBlur = 4; ctx.shadowColor = 'black';
              ctx.fillText(`${Math.ceil(t.hp)} / ${maxHp}`, 0, -55);
              ctx.shadowBlur = 0;

              ctx.font = '10px Inter';
              ctx.textAlign = 'right';
              ctx.fillText('🛡️', -28, -40);
            }
            ctx.rotate((t.rotation || 0) * Math.PI / 180); // Re-rotate for cracks

            // Cracked Texture (Wall)
            if (t.hp <= 20) {
              ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)'; ctx.lineWidth = 2;
              ctx.beginPath(); ctx.moveTo(-20, -10); ctx.lineTo(-10, 5); ctx.lineTo(0, -5); ctx.stroke();
              ctx.beginPath(); ctx.moveTo(10, 5); ctx.lineTo(20, -10); ctx.stroke();
            }
          } else if (t.type === 'gate') {
            const gx = Math.round(t.pos.x / GRID_SIZE);
            const gy = Math.round(t.pos.y / GRID_SIZE);
            const n_t = buildingMapRef.current.get(`${gx}_${gy-1}`);
            const n_b = buildingMapRef.current.get(`${gx}_${gy+1}`);
            const n_l = buildingMapRef.current.get(`${gx-1}_${gy}`);
            const n_r = buildingMapRef.current.get(`${gx+1}_${gy}`);

            if (t.rotation) ctx.rotate(t.rotation * Math.PI / 180);
            
            if (renderEmpireId === 'rim') {
              // --- Russian Log Gate (Теремные Ворота) ---
              // Massive Side Pillars (Logs)
              ctx.fillStyle = '#3e2723';
              ctx.fillRect(-35, -25, 12, 50); // Left log
              ctx.fillRect(23, -25, 12, 50);  // Right log
              
              // Roof (Upper beam)
              ctx.fillStyle = '#2b1d1a';
              ctx.beginPath();
              ctx.moveTo(-38, -25); ctx.lineTo(0, -40); ctx.lineTo(38, -25); ctx.lineTo(38, -18); ctx.lineTo(-38, -18);
              ctx.fill();

              if (!t.isOpen) {
                // Main Door Panel
                ctx.fillStyle = '#4e342e';
                ctx.fillRect(-23, -22, 46, 44);
                
                // Vertical Log Texture on door
                ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 1;
                for(let i=-2; i<=2; i++) {
                  ctx.beginPath(); ctx.moveTo(i*9, -22); ctx.lineTo(i*9, 22); ctx.stroke();
                }

                // Iron Forged Elements (Decorative Crossbars)
                ctx.fillStyle = '#1e293b';
                ctx.fillRect(-23, -10, 46, 3);
                ctx.fillRect(-23, 10, 46, 3);
                
                // Iron Bolts (Rivets)
                ctx.fillStyle = '#334155';
                for(let i=-2; i<=2; i++) {
                  ctx.beginPath(); ctx.arc(i*15, -10, 2, 0, Math.PI*2); ctx.fill();
                  ctx.beginPath(); ctx.arc(i*15, 10, 2, 0, Math.PI*2); ctx.fill();
                }

                // Golden Ring Handles
                ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(-8, 5, 5, 0, Math.PI*2); ctx.stroke();
                ctx.beginPath(); ctx.arc(8, 5, 5, 0, Math.PI*2); ctx.stroke();
              } else {
                // OPENED: Show hollow passage with depth
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillRect(-21, -22, 42, 44);
                ctx.restore();
                
                // Draw inner frame shadows
                ctx.fillStyle = 'rgba(0,0,0,0.3)';
                ctx.fillRect(-23, -22, 2, 44);
                ctx.fillRect(21, -22, 2, 44);
              }
            } else if (renderEmpireId === 'fim') {
              // --- French Iron Gate (Портал) ---
              // Ornate Stone Pillars with Blue Slate tops
              ctx.fillStyle = '#94a3b8';
              ctx.fillRect(-DRAW_LENGTH/2, -25, 14, 50); ctx.fillRect(DRAW_LENGTH/2-14, -25, 14, 50);
              
              if (!t.isOpen) {
                ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.5;
                for(let i=-4; i<=4; i++) {
                  ctx.beginPath(); ctx.moveTo(i*(DRAW_LENGTH/10), -20); ctx.lineTo(i*(DRAW_LENGTH/10), 20); ctx.stroke();
                }
              } else {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillRect(-(DRAW_LENGTH-28)/2, -20, DRAW_LENGTH-28, 40);
                ctx.restore();
              }
            } else {
              // --- Ottoman Stone Arch Gate ---
              ctx.fillStyle = '#d4a373';
              ctx.beginPath(); ctx.moveTo(-DRAW_LENGTH/2, 25); ctx.lineTo(-DRAW_LENGTH/2, -15); ctx.quadraticCurveTo(0, -45, DRAW_LENGTH/2, -15); ctx.lineTo(DRAW_LENGTH/2, 25); ctx.fill();
              
              if (!t.isOpen) {
                // CLOSED: Solid Wooden Door with Iron Accents
                ctx.fillStyle = '#4a2511'; // Dark rich wood
                ctx.fillRect(-(DRAW_LENGTH-12)/2, -15, DRAW_LENGTH-12, 38);
                
                // Iron Bands for reinforcement
                ctx.fillStyle = '#1e293b'; // Slate dark iron
                ctx.fillRect(-(DRAW_LENGTH-12)/2, -5, DRAW_LENGTH-12, 3);
                ctx.fillRect(-(DRAW_LENGTH-12)/2, 10, DRAW_LENGTH-12, 3);
                
                // Decorative handle/ring
                ctx.strokeStyle = '#fbbf24'; // Gold/Brass
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(0, 5, 6, 0, Math.PI * 2);
                ctx.stroke();
              } else {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.beginPath(); ctx.moveTo(-(DRAW_LENGTH-16)/2, 25); ctx.lineTo(-(DRAW_LENGTH-16)/2, -10); ctx.quadraticCurveTo(0, -35, (DRAW_LENGTH-16)/2, -10); ctx.lineTo((DRAW_LENGTH-16)/2, 25); ctx.fill();
                ctx.restore();
              }
            }
            
            // DRAW JOINTS FOR GATES TOO (Perfect tile joints)
            ctx.rotate(-(t.rotation || 0) * Math.PI / 180);
            const jointColor = renderEmpireId === 'rim' ? '#4e342e' : (renderEmpireId === 'fim' ? '#cbd5e1' : '#d4a373');
            const jSize = renderEmpireId === 'fim' ? 36 : 30;
            const halfWall = DRAW_LENGTH / 2;
            const halfThick = jSize / 2;
            const offset = GRID_SIZE / 2;

            if (t.rotation === 0) {
              if (n_t && (n_t.type === 'wall' || n_t.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(-halfThick, -offset - halfThick, jSize, jSize);
              }
              if (n_b && (n_b.type === 'wall' || n_b.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(-halfThick, offset - halfThick, jSize, jSize);
              }
              // Clean L-junction overlaps for gates
              if (!n_l && (n_t || n_b)) {
                 ctx.fillStyle = jointColor;
                 ctx.fillRect(-halfWall, -halfThick, halfWall - halfThick, jSize);
              }
              if (!n_r && (n_t || n_b)) {
                 ctx.fillStyle = jointColor;
                 ctx.fillRect(halfThick, -halfThick, halfWall - halfThick, jSize);
              }
            } else {
              if (n_l && (n_l.type === 'wall' || n_l.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(-offset - halfThick, -halfThick, jSize, jSize);
              }
              if (n_r && (n_r.type === 'wall' || n_r.type === 'gate')) {
                ctx.fillStyle = jointColor;
                ctx.fillRect(offset - halfThick, -halfThick, jSize, jSize);
              }
            }
            ctx.rotate((t.rotation || 0) * Math.PI / 180);
            
            // Faction Banner on top
            ctx.fillStyle = t.color;
            ctx.fillRect(-10, -30, 20, 10);
            
            // Interaction Hint (Press F to Open/Close) - Only for owner
            if (localHeadPos && (t.ownerId === myId || t.color === playerRef.current?.color || t.faction === playerRef.current?.color)) {
                const dist = getDistanceSimple(localHeadPos.x, localHeadPos.y, t.pos.x, t.pos.y);
                if (dist < 150) {
                    const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
                    ctx.save();
                    ctx.rotate(-(t.rotation || 0) * Math.PI / 180); // Un-rotate to draw text horizontally
                    
                    // Bubble background
                    ctx.fillStyle = 'rgba(0,0,0,0.8)';
                    ctx.beginPath();
                    ctx.rect(-45, -85, 90, 24);
                    ctx.fill();
                    ctx.strokeStyle = '#fbbf24';
                    ctx.lineWidth = 1;
                    ctx.stroke();

                    if (isMobile) {
                        ctx.fillStyle = '#fbbf24';
                        ctx.font = 'bold 10px Inter, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('TAP TO ' + (t.isOpen ? 'CLOSE' : 'OPEN'), 0, -68);
                    } else {
                        // Key hint
                        ctx.fillStyle = '#fbbf24';
                        ctx.font = 'bold 14px Inter, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('F', -30, -68);
                        
                        // Action text
                        ctx.fillStyle = '#ffffff';
                        ctx.font = '10px Inter, sans-serif';
                        ctx.textAlign = 'left';
                        ctx.fillText(t.isOpen ? 'CLOSE' : 'OPEN', -15, -68);
                    }
                    
                    ctx.restore();
                }
            }
            
            // Un-rotate for health bar
            ctx.rotate(-(t.rotation || 0) * Math.PI / 180);
            const maxHp = (t.type === 'tower') ? TOWER_MAX_HP : (t.type === 'gate' ? GATE_MAX_HP : WALL_MAX_HP);
            if (t.hp < maxHp - 0.01) {
              const bWidth = 50;
              const hRatio = Math.max(0, Math.min(1, t.hp / maxHp));
              const clampedW = Math.max(0, Math.min(bWidth, bWidth * hRatio));
              ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-25, -45, bWidth, 6);
              ctx.fillStyle = '#ef4444'; ctx.fillRect(-25, -45, bWidth, 6);
              ctx.fillStyle = '#22c55e'; ctx.fillRect(-25, -45, clampedW, 6);
              
              // HP TEXT (e.g. "9 / 10")
              ctx.font = 'bold 12px Inter, sans-serif';
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.shadowBlur = 4; ctx.shadowColor = 'black';
              ctx.fillText(`${Math.ceil(t.hp)} / ${maxHp}`, 0, -55);
              ctx.shadowBlur = 0;

              ctx.font = '10px Inter';
              ctx.textAlign = 'right';
              ctx.fillText('🛡️', -28, -40);
            }
          } else if (t.type === 'tower' || !t.type) {
            if (renderEmpireId === 'rim') {
              // --- Russian Krepost (Fortress) ---
              // 1. Log Base
              ctx.fillStyle = '#5d4037';
              ctx.fillRect(-35, -50, 70, 70);
              // Log texture
              ctx.strokeStyle = '#3e2723'; ctx.lineWidth = 1.5;
              for(let i=0; i<4; i++) {
                ctx.beginPath(); ctx.moveTo(-35, -50 + i*17.5); ctx.lineTo(35, -50 + i*17.5); ctx.stroke();
              }

              // 2. Wooden Overhang
              ctx.fillStyle = '#4e342e';
              ctx.fillRect(-42, -60, 84, 15);
              
              // 3. Green Pointed Roof
              ctx.fillStyle = '#1b4332'; // Dark green roof
              ctx.beginPath();
              ctx.moveTo(-45, -60);
              ctx.lineTo(0, -110);
              ctx.lineTo(45, -60);
              ctx.fill();

              // 4. Spire with Cross
              ctx.fillStyle = '#fbbf24'; // Gold
              ctx.fillRect(-1, -125, 2, 15);
              ctx.fillRect(-4, -120, 8, 2); // Horizontal cross bar
              ctx.fillRect(-1, -115, 2, 5);

            } else if (renderEmpireId === 'fim') {
              // --- French Bastion ---
              // 1. Gray Stone Base
              ctx.fillStyle = '#94a3b8';
              ctx.fillRect(-35, -50, 70, 70);
              // Stone texture (bricks)
              ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1;
              for(let i=0; i<4; i++) {
                ctx.beginPath(); ctx.moveTo(-35, -50 + i*17.5); ctx.lineTo(35, -50 + i*17.5); ctx.stroke();
              }

              // 2. Balcony
              ctx.fillStyle = '#cbd5e1';
              ctx.fillRect(-40, -60, 80, 10);

              // 3. Blue Slate Roof
              ctx.fillStyle = '#1e3a8a'; // Deep blue roof
              ctx.beginPath();
              ctx.moveTo(-40, -60);
              ctx.lineTo(-25, -95);
              ctx.lineTo(25, -95);
              ctx.lineTo(40, -60);
              ctx.fill();
              
              // Upper roof tip
              ctx.beginPath();
              ctx.moveTo(-25, -95);
              ctx.lineTo(0, -120);
              ctx.lineTo(25, -95);
              ctx.fill();

              // 4. Tricolor Flag
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, -140, 2, 20); // Pole
              // Blue/White/Red Flag
              ctx.fillStyle = '#002395'; ctx.fillRect(2, -140, 6, 10);
              ctx.fillStyle = '#ffffff'; ctx.fillRect(8, -140, 6, 10);
              ctx.fillStyle = '#ed2939'; ctx.fillRect(14, -140, 6, 10);

            } else {
              // --- Ottoman Tower (Original) ---
              // 1. Stone Base (Sandstone)
              ctx.fillStyle = '#d4a373'; 
              ctx.fillRect(-35, -50, 70, 70);
              // Stone Texture
              ctx.strokeStyle = '#bc8a5f'; ctx.lineWidth = 1;
              for(let i=0; i<3; i++) {
                ctx.beginPath(); ctx.moveTo(-35, -50 + i*23); ctx.lineTo(35, -50 + i*23); ctx.stroke();
              }

              // 2. Wooden Balcony
              ctx.fillStyle = '#451a03';
              ctx.fillRect(-40, -60, 80, 15);
              // Balcony railing
              ctx.strokeStyle = '#78350f'; ctx.lineWidth = 2;
              for(let i=0; i<8; i++) {
                ctx.beginPath(); ctx.moveTo(-35 + i*10, -60); ctx.lineTo(-35 + i*10, -45); ctx.stroke();
              }

              // 3. Faction Banner
              ctx.fillStyle = t.color;
              ctx.fillRect(-15, -45, 30, 10);

              // 4. Upper Tower Section
              ctx.fillStyle = '#faedcd';
              ctx.fillRect(-25, -90, 50, 30);

              // 5. Teal/Gold Dome
              ctx.fillStyle = '#0d9488'; // Teal
              ctx.beginPath();
              ctx.arc(0, -90, 30, Math.PI, 0);
              ctx.fill();
              
              // Dome spike
              ctx.fillStyle = '#fbbf24';
              ctx.fillRect(-1, -135, 2, 15);

              // Golden Crescent
              ctx.save();
              ctx.translate(0, -135);
              ctx.fillStyle = '#fbbf24';
              ctx.beginPath();
              ctx.arc(0, 0, 6, 0, Math.PI * 2);
              ctx.fill();
              ctx.globalCompositeOperation = 'destination-out';
              ctx.beginPath();
              ctx.arc(3, -2, 6, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
            }

            // Health Bar (Tower) - Fixed clamping and added Shield Icon
            if (t.hp < TOWER_MAX_HP - 0.01) {
              const bWidth = 60;
              const hRatio = Math.max(0, Math.min(1, t.hp / TOWER_MAX_HP));
              const clampedW = Math.max(0, Math.min(bWidth, bWidth * hRatio));
              ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-30, -155, bWidth, 7);
              ctx.fillStyle = '#ef4444'; ctx.fillRect(-30, -155, bWidth, 7);
              ctx.fillStyle = '#22c55e'; ctx.fillRect(-30, -155, clampedW, 7);
              
              // HP TEXT
              ctx.font = 'bold 12px Inter, sans-serif';
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.shadowBlur = 4; ctx.shadowColor = 'black';
              ctx.fillText(`${Math.ceil(t.hp)} / ${TOWER_MAX_HP}`, 0, -165);
              ctx.shadowBlur = 0;

              ctx.font = '12px Inter';
              ctx.textAlign = 'right';
              ctx.fillText('🛡️', -35, -148);
            }
          }
          ctx.restore();
      });
      projectilesRef.current.forEach(pr => {
        if (!isPointInView(pr.pos.x, pr.pos.y, 100)) return;
        const px = pr.pos.x, py = pr.pos.y;
        
        let boltColor = '#fbbf24'; // Default Gold
        let trailLen = 35;
        let trailWidth = 6;
        let shadowColor = boltColor;

        if (pr.empireId === 'rim') {
          boltColor = '#475569'; // Dark Slate/Iron
          shadowColor = '#94a3b8';
          trailLen = 45;
          trailWidth = 4;
        } else if (pr.empireId === 'fim') {
          boltColor = '#f97316'; // Orange/Fire
          shadowColor = '#fbbf24';
          trailLen = 30;
          trailWidth = 8;
        }

        ctx.save();
        ctx.shadowBlur = 20;
        ctx.shadowColor = shadowColor;
        
        // Projectile Head
        ctx.fillStyle = boltColor;
        ctx.beginPath();
        ctx.arc(px, py, pr.empireId === 'fim' ? 6 : 5, 0, Math.PI * 2);
        ctx.fill();
        
        // Trail
        const angle = Math.atan2(pr.vel.y, pr.vel.x);
        const grad = ctx.createLinearGradient(px, py, px - Math.cos(angle) * trailLen, py - Math.sin(angle) * trailLen);
        grad.addColorStop(0, boltColor);
        grad.addColorStop(1, 'transparent');
        
        ctx.strokeStyle = grad;
        ctx.lineWidth = trailWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - Math.cos(angle) * trailLen, py - Math.sin(angle) * trailLen);
        ctx.stroke();
        
        ctx.restore();
      });
      
      // Ground details (noise) - Optimization: Lower count and distance check
      ctx.fillStyle = '#166534';
      for (let i = 0; i < 50; i++) {
          const rx = (Math.abs(Math.sin(i * 123.456) * 789.012) * currentWorldSize) % currentWorldSize;
          const ry = (Math.abs(Math.cos(i * 456.789) * 123.012) * currentWorldSize) % currentWorldSize;
          if (isPointInView(rx, ry, 10)) {
            ctx.fillRect(rx, ry, 2, 2);
          }
      }

      // Obstacles (Base layer)
      gameMapRef.current.obstacles.forEach(o => {
          if (!isPointInView(o.center.x, o.center.y, o.radius + 150)) return;
          const ox = o.center.x, oy = o.center.y;
          
          if (o.type === 'grass') {
              ctx.fillStyle = 'rgba(20, 83, 45, 0.4)';
              ctx.beginPath(); ctx.arc(ox, oy, o.radius, 0, Math.PI * 2); ctx.fill();
              ctx.strokeStyle = 'rgba(34, 197, 94, 0.2)'; ctx.lineWidth = 4; ctx.stroke();
          } else if (o.type === 'tree') {
              // Trunk shadow
              ctx.fillStyle = 'rgba(0,0,0,0.3)';
              ctx.beginPath(); ctx.ellipse(ox, oy + 25, 20, 10, 0, 0, Math.PI * 2); ctx.fill();
              // Thick Trunk
              ctx.fillStyle = '#451a03';
              ctx.fillRect(ox - 12, oy - 10, 24, 40);
              ctx.strokeStyle = '#78350f'; ctx.lineWidth = 2; ctx.strokeRect(ox - 12, oy - 10, 24, 40);
          } else if (o.type === 'boulder' && o.points) {
              // Boulder shadow
              ctx.fillStyle = 'rgba(0,0,0,0.2)';
              ctx.beginPath(); ctx.ellipse(ox, oy + o.radius * 0.3, o.radius * 1.1, o.radius * 0.4, 0, 0, Math.PI * 2); ctx.fill();
              // Boulder
              ctx.fillStyle = o.color;
              ctx.beginPath(); o.points.forEach((pt, i) => { if (i===0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
              ctx.closePath(); ctx.fill();
              ctx.strokeStyle = '#334155'; ctx.lineWidth = 2; ctx.stroke();
          }
      });

      // --- Draw Villages ---
      gameMapRef.current.villages.forEach(v => {
        if (!isPointInView(v.pos.x, v.pos.y, 400)) return;
        
        ctx.save();
        ctx.translate(v.pos.x, v.pos.y);
        
        // Ground Area
        ctx.beginPath();
        ctx.arc(0, 0, v.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120, 53, 15, 0.1)';
        ctx.fill();
        
        // --- Draw Market Stalls ---
        const seedNum = parseInt(v.id.split('-')[1]) || 0;
        const rand = new SeededRandom(seedNum + 500);
        for (let i = 0; i < 4; i++) {
          const ang = (i / 4) * Math.PI * 2 + (rand.next() * 0.5);
          const dist = v.radius * 0.6;
          const sx = Math.cos(ang) * dist;
          const sy = Math.sin(ang) * dist;
          
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(ang + Math.PI/2);
          
          // Stall Table
          ctx.fillStyle = '#451a03';
          ctx.fillRect(-15, -10, 30, 20);
          
          // Stall Roof (Striped)
          ctx.fillStyle = i % 2 === 0 ? '#ef4444' : '#3b82f6';
          ctx.fillRect(-18, -12, 36, 5);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(-18, -12, 6, 5); ctx.fillRect(6, -12, 6, 5); ctx.fillRect(18-6, -12, 6, 5);
          
          ctx.restore();
        }

        // --- Draw Residents (NPCs) ---
        // OPTIMIZATION: Residents only "move" at 30 FPS to save CPU
        const npcTime = Math.floor(Date.now() / 33) * 0.033;
        for (let i = 0; i < 5; i++) {
          const npcSeed = seedNum + i * 100;
          const npcRand = new SeededRandom(npcSeed);
          const orbitRadius = v.radius * (0.3 + npcRand.next() * 0.4);
          const orbitSpeed = 0.2 + npcRand.next() * 0.3;
          const nx = Math.cos(npcTime * orbitSpeed + npcSeed) * orbitRadius;
          const ny = Math.sin(npcTime * orbitSpeed + npcSeed) * orbitRadius;
          
          ctx.save();
          ctx.translate(nx, ny);
          // Simple Resident Circle
          ctx.fillStyle = '#d4a373'; // Skin tone-ish
          ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = EMPIRE_COLORS.neutral; // Simple clothes
          ctx.beginPath(); ctx.arc(0, 2, 5, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        
        // Progress Ring
        if (v.captureProgress > 0 && v.captureProgress < 100) {
          ctx.beginPath();
          ctx.arc(0, 0, v.radius, -Math.PI/2, -Math.PI/2 + (v.captureProgress/100)*Math.PI*2);
          ctx.strokeStyle = v.color || '#78350f';
          ctx.lineWidth = 6;
          ctx.stroke();
        } else if (v.ownerId) {
          ctx.beginPath();
          ctx.arc(0, 0, v.radius, 0, Math.PI * 2);
          ctx.strokeStyle = v.color || '#78350f';
          ctx.lineWidth = 4;
          ctx.stroke();
          
          ctx.fillStyle = (v.color || '#78350f') + '22';
          ctx.fill();
        }

        // Village Name & Icon
        ctx.fillStyle = 'white';
        ctx.font = '24px Inter';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 4; ctx.shadowColor = 'black';
        ctx.fillText('🏠', 0, -20);
        ctx.font = 'bold 16px Inter';
        ctx.fillText(v.name || 'Village', 0, 10);
        
        if (v.ownerId) {
          ctx.font = 'bold 10px Inter';
          ctx.fillStyle = v.color || '#ffffff';
          ctx.fillText('OWNED BY ' + v.ownerId.toUpperCase(), 0, 30);
        }
        
        ctx.shadowBlur = 0;
        ctx.restore();
      });

      // --- RENDER CARAVANS REWRITE ---
      caravansRef.current.forEach(c => {
        if (!isPointInView(c.pos.x, c.pos.y, 100)) return;
        // NEW: Layer isolation for Caravans (Surface only)
        if (!isSpectatorRef.current && playerRef.current?.isUnderground) return;

        ctx.save();
        ctx.translate(c.pos.x, c.pos.y);
        
        // Draw Escort Circle
        const sid = socketRef.current?.id || myIdRef.current;
        const isMeEscorting = c.escortOwnerId === sid;

        if (isMeEscorting || (!c.escortOwnerId && playerRef.current && getDistance(c.pos, playerRef.current.units[0]?.pos) < 400)) {
            ctx.beginPath();
            ctx.arc(0, 0, 250, 0, Math.PI * 2);
            ctx.fillStyle = isMeEscorting ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255, 255, 255, 0.05)';
            ctx.fill();
            ctx.strokeStyle = isMeEscorting ? 'rgba(34, 197, 94, 0.5)' : 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 2;
            if (isMeEscorting && (c.outOfCircleTime || 0) > 0) {
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)'; // Red if out of bounds
                ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
                ctx.fill();
                ctx.setLineDash([10, 10]);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const ang = Math.atan2(c.targetPos.y - c.pos.y, c.targetPos.x - c.pos.x);
        ctx.rotate(ang);
        
        // 1. Caravan Body
        ctx.fillStyle = '#78350f';
        ctx.fillRect(-30, -20, 60, 40);
        ctx.fillStyle = '#92400e';
        ctx.fillRect(-25, -15, 50, 30);
        
        // 2. Wheels
        ctx.fillStyle = '#271101';
        const wheelRot = Date.now() * 0.01;
        [[-20,-20], [20,-20], [-20,20], [20,20]].forEach(([wx, wy]) => {
          ctx.save();
          ctx.translate(wx, wy);
          ctx.rotate(wheelRot);
          ctx.fillRect(-5, -2, 10, 4);
          ctx.fillRect(-2, -5, 4, 10);
          ctx.restore();
        });

        // 3. UI Overlay
        ctx.rotate(-ang); // Un-rotate for text
        
        if (c.escortOwnerId) {
            // Display active escort state
            if (isMeEscorting) {
                // Timer for local owner
                ctx.fillStyle = 'white';
                ctx.font = 'bold 24px Inter';
                ctx.textAlign = 'center';
                ctx.shadowBlur = 4; ctx.shadowColor = 'black';
                ctx.fillText(`${c.escortTimer}s`, 0, -65);
                
                ctx.font = 'bold 10px Inter';
                ctx.fillStyle = '#22c55e';
                ctx.fillText(t.protecting || 'PROTECTING', 0, -90);
                
                if ((c.outOfCircleTime || 0) > 0) {
                    const rem = Math.max(0, (3000 - (c.outOfCircleTime || 0)) / 1000).toFixed(1);
                    ctx.fillStyle = '#ef4444';
                    ctx.font = 'bold 14px Inter';
                    ctx.fillText(`${t.returnToCircle || 'RETURN!'} ${rem}s`, 0, -110);
                }
            } else {
                // Name for others
                const owner = entitiesRef.current.find(e => e.id === c.escortOwnerId);
                const ownerName = owner?.name || 'Commander';
                ctx.fillStyle = 'white';
                ctx.font = 'bold 12px Inter';
                ctx.textAlign = 'center';
                ctx.shadowBlur = 4; ctx.shadowColor = 'black';
                ctx.fillText(`ESCORTED BY ${ownerName.toUpperCase()}`, 0, -60);
            }
        } else {
            // Display "Press F" hint
            const pHead = playerRef.current?.units[0];
            if (pHead && getDistance(c.pos, pHead.pos) < 250) {
                const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
                ctx.save();
                // Bubble
                ctx.fillStyle = 'rgba(0,0,0,0.85)';
                ctx.beginPath();
                ctx.rect(-65, -100, 130, 28);
                ctx.fill();
                ctx.strokeStyle = '#fbbf24';
                ctx.lineWidth = 2;
                ctx.stroke();

                if (isMobile) {
                    ctx.fillStyle = '#fbbf24';
                    ctx.font = 'bold 12px Inter, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('TAP TO PROTECT', 0, -81);
                } else {
                    // F Key
                    ctx.fillStyle = '#fbbf24';
                    ctx.font = 'bold 16px Inter, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('F', -45, -81);
                    
                    // Text
                    ctx.fillStyle = 'white';
                    ctx.font = 'bold 11px Inter, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText('START PROTECT', -25, -81);
                }
                ctx.restore();
            }
        }
        
        // Caravan Label
        ctx.fillStyle = 'white';
        ctx.font = 'bold 12px Inter';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 4; ctx.shadowColor = 'black';
        ctx.fillText(`💰 ${t.caravan}`, 0, -40);
        ctx.shadowBlur = 0;
        
        ctx.restore();
      });

      // Neutrals
      neutralsRef.current.forEach(n => {
        if (!isPointInView(n.pos.x, n.pos.y, 100)) return;
        // NEW: Layer isolation for Neutrals (Holops are surface only)
        if (!isSpectatorRef.current && playerRef.current?.isUnderground) return;
        
        const sprite = getUnitSprite('neutral', false, '#94a3b8', n.type);
        ctx.save();
        ctx.translate(n.pos.x, n.pos.y);
        ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
        ctx.restore();
      });

      // Akçe Passive Income - Handled in update loop


      garrisonsRef.current.forEach(g => {
          if (isPointInView(g.pos.x, g.pos.y, 300)) {
               // NEW: Layer Isolation for Garrisons
               if (!isSpectatorRef.current && g.isUnderground !== playerRef.current?.isUnderground) {
                 return; 
               }

               const empireId = g.empireId || 'neutral';
               const isAttacking = g.attackTimer > 0;
               
               // PRE-GET SPRITE for the whole garrison
               const sprite = getUnitSprite(empireId, false, g.color, 'infantry');
               let opacity = 1.0;
               const gInGrass = gameMapRef.current.obstacles.find(o => o.type === 'grass' && getDistance(g.pos, o.center) < o.radius);
               if (gInGrass) opacity = 0.5;

               ctx.globalAlpha = opacity;

               g.units.forEach((u, i) => {
                  if (!isPointInView(u.pos.x, u.pos.y, 100)) return;

                  if (!isAttacking) {
                    // Use sprite for all non-attacking units (BATCH-LIKE)
                    ctx.drawImage(sprite, u.pos.x - sprite.width / 2, u.pos.y - sprite.height / 2);
                  } else {
                    drawUnit(ctx, u.pos.x, u.pos.y, g.color, false, 0, i < 5, g.attackTimer, opacity, u.type, empireId);
                  }
              });
              ctx.globalAlpha = 1.0;
              
              if (g.mode === 'RECALL') {
                  const owner = entitiesRef.current.find(e => e.id === g.ownerId);
                  if (owner && owner.units.length > 0) {
                      ctx.setLineDash([5, 5]);
                      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                      ctx.beginPath();
                      ctx.moveTo(g.pos.x, g.pos.y);
                      ctx.lineTo(owner.units[0].pos.x, owner.units[0].pos.y);
                      ctx.stroke();
                      ctx.setLineDash([]);
                  }
              }

              if (g.isPulsing) {
                  ctx.strokeStyle = 'white';
                  ctx.lineWidth = 3;
                  ctx.beginPath();
                  ctx.arc(g.pos.x, g.pos.y, 50 + Math.sin(Date.now()*0.01)*10, 0, Math.PI*2);
                  ctx.stroke();
              }
              
              ctx.save();
              ctx.translate(g.pos.x, g.pos.y - 50);
              ctx.fillStyle = g.color;
              ctx.beginPath();
              ctx.arc(0, 0, 12, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = 'white';
              ctx.lineWidth = 2;
              ctx.stroke();
              
              ctx.fillStyle = 'white';
              ctx.font = 'bold 10px Inter';
              ctx.textAlign = 'center';
              let icon = '🛡️';
              if (g.mode === 'HUNT') icon = '⚔️';
              if (g.mode === 'RECALL') icon = '🏃';
              ctx.fillText(icon, 0, 4);

              // Unit Count Label (e.g. "18U")
              ctx.fillStyle = 'white';
              ctx.font = '900 12px Inter';
              ctx.shadowBlur = 4; ctx.shadowColor = 'black';
              ctx.fillText(`${g.units.length}U`, 0, -18);
              
              // Garrison Number (for local player)
              if (g.ownerId === myId) {
                  const myGarrisons = garrisonsRef.current.filter(xg => xg.ownerId === myId);
                  const gIdx = myGarrisons.findIndex(xg => xg.id === g.id);
                  if (gIdx !== -1) {
                      ctx.fillStyle = '#fbbf24';
                      ctx.font = '900 20px Inter';
                      ctx.fillText(`#${gIdx + 1}`, 0, -35);
                  }
              }
              ctx.shadowBlur = 0;

              // REJOIN PROMPT
              if (g.ownerId === myId && localHeadPos && getDistanceSimple(g.pos.x, g.pos.y, localHeadPos.x, localHeadPos.y) < 150) {
                  const isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
                  ctx.fillStyle = 'rgba(0,0,0,0.85)';
                  ctx.beginPath();
                  ctx.rect(-55, -85, 110, 24);
                  ctx.fill();
                  ctx.strokeStyle = '#3b82f6';
                  ctx.lineWidth = 2;
                  ctx.stroke();

                  ctx.fillStyle = 'white';
                  ctx.font = 'bold 10px Inter, sans-serif';
                  ctx.textAlign = 'center';
                  ctx.fillText(isMobile ? 'TAP TO REJOIN' : 'F : REJOIN', 0, -68);
              }

              ctx.restore();
          }
      });

      // Entities (GHOST PROTOCOL: Enhanced Sultan Sync)
      // First, ensure local player is drawn even if server data is pending
      const drawEntities = [...entitiesRef.current];
      
      // If in lobby and local player is missing from entitiesRef for some reason, we draw them anyway
      if (ENGINE_STATE === 'LOBBY_WAITING' && !drawEntities.find(e => e.id === myId)) {
          const sid = socketRef.current?.id || myId;
          drawEntities.push({
            id: sid,
            name: nickname,
            type: 'player',
            units: [{ id: 'local-ghost', pos: { x: 600, y: 600 }, color: playerColor, type: 'infantry', hp: 100 }],
            color: playerColor,
            faction: playerColor,
            score: 1,
            akce: 0,
            isDashing: false,
            velocity: { x: 0, y: 0 },
            facingAngle: 0,
            isAttacking: false,
            attackTimer: 0,
            attackCooldown: 0,
            weightSlowdown: 0,
            splitCooldown: 0
          });
      }

      drawEntities.forEach(ent => {
          if (ent.units.length === 0) return;
          const head = ent.units[0];
          
          if (!isPointInView(head.pos.x, head.pos.y, VIEWPORT_BUFFER * 2)) return;

          // NEW: Layer Isolation - Only see units in the same layer
          const p = playerRef.current;
          if (!isSpectatorRef.current && ent.isUnderground === true && !p?.isUnderground) {
            return; // Invisible across layers
          }

          // Fog of War: Hide underground enemy units unless we are also underground
          const sid = socketRef.current?.id || myId;
          const isLocal = ent.id === sid;
          if (!isSpectatorRef.current && !isLocal && ent.isUnderground && (!p || !p.isUnderground)) {
            return; // Invisible (redundant but safe)
          }

          // DISABLED FOW/STEALTH FOR ALL ENTITIES TO FIX INVISIBILITY BUG
          let opacity = ent.isUnderground ? 0.4 : 1.0;
          let hideName = ent.isUnderground;
          const entInGrass = gameMapRef.current.obstacles.find(o => o.type === 'grass' && getDistance(head.pos, o.center) < o.radius);
          if (entInGrass && !ent.isUnderground) {
              opacity = 0.5;
              hideName = true;
          }

          const empireId = ent.empireId || 'neutral';
          const sprite = getUnitSprite(empireId, false, ent.color, 'infantry');
          
          ctx.globalAlpha = opacity;
          
          // Draw regular units first
          ent.units.forEach((u, i) => {
              if (i === 0) return; // Skip commander
              if (!isPointInView(u.pos.x, u.pos.y, VIEWPORT_BUFFER)) return;

              // Use sprite for ALL non-attacking units (HUGE performance gain)
              if (!ent.isAttacking) {
                ctx.save();
                ctx.translate(u.pos.x, u.pos.y);
                ctx.rotate(ent.facingAngle + Math.PI / 2);
                ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
                ctx.restore();
              } else {
                drawUnit(ctx, u.pos.x, u.pos.y, ent.color, false, ent.facingAngle, false, 0, opacity, u.type, empireId);
              }
          });
          ctx.globalAlpha = 1.0;

          // Draw commander last to be on top
          if (isPointInView(head.pos.x, head.pos.y, VIEWPORT_BUFFER)) {
              if (ent.id === myId && isSpectatorRef.current) {
                  drawUnit(ctx, head.pos.x, head.pos.y, '#888888', true, ent.facingAngle, ent.isAttacking, ent.attackTimer, 0.4, head.type, initialEmpire.id, ent.equippedItem);
                  
                  ctx.fillStyle = '#ff0000';
                  ctx.font = 'bold 16px Arial';
                  ctx.textAlign = 'center';
                  ctx.fillText('DEAD', head.pos.x, head.pos.y - 65);
              } else {
                  drawUnit(ctx, head.pos.x, head.pos.y, ent.color, true, ent.facingAngle, ent.isAttacking, ent.attackTimer, opacity, head.type, empireId, ent.equippedItem);
                  
                  // LAG DETECTION
                  if (ent.id !== myId && ent.lastUpdate && (Date.now() - ent.lastUpdate > 3000)) {
                      ctx.fillStyle = '#ef4444';
                      ctx.font = 'bold 10px Inter';
                      ctx.textAlign = 'center';
                      ctx.fillText('LAGGING...', head.pos.x, head.pos.y - 85);
                  }
              }
          }
          
          if (!hideName || ent.id === myId) {
              ctx.fillStyle = ent.id === myId ? '#fbbf24' : 'white';
              ctx.font = '900 14px Inter'; ctx.textAlign = 'center';
              ctx.shadowColor = 'black'; ctx.shadowBlur = 4;
              ctx.fillText(ent.name, head.pos.x, head.pos.y - 50);
              ctx.shadowBlur = 0;
          }

          const visibleSoldierCount = ent.id === myId
            ? Math.max(0, ent.units.length - 1)
            : (typeof ent.lastKnownUnitCount === 'number' ? Math.max(0, ent.lastKnownUnitCount) : Math.max(0, ent.units.length - 1));
          if (visibleSoldierCount === 0) {
              const hpBarWidth = 42;
              const hpBarHeight = 5;
              const hpRatio = Math.max(0, Math.min(1, (head.hp || COMMANDER_MAX_HP) / COMMANDER_MAX_HP));
              ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
              ctx.fillRect(head.pos.x - hpBarWidth / 2, head.pos.y - 42, hpBarWidth, hpBarHeight);
              ctx.fillStyle = '#ef4444';
              ctx.fillRect(head.pos.x - hpBarWidth / 2, head.pos.y - 42, hpBarWidth * hpRatio, hpBarHeight);
              ctx.strokeStyle = 'rgba(255,255,255,0.45)';
              ctx.lineWidth = 1;
              ctx.strokeRect(head.pos.x - hpBarWidth / 2, head.pos.y - 42, hpBarWidth, hpBarHeight);
          }
          
        if (ent.id === myId && ent.attackCooldown > 0) {
            const barW = 40, barH = 4;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(head.pos.x - barW/2, head.pos.y + 30, barW, barH);
            ctx.fillStyle = '#fbbf24';
            ctx.fillRect(head.pos.x - barW/2, head.pos.y + 30, barW * (1 - ent.attackCooldown / 500), barH);
        }
    });

      // Tree Foliage (Top Layer)
      gameMapRef.current.obstacles.forEach(o => {
          if (o.type === 'tree') {
              if (isPointInView(o.center.x, o.center.y, o.radius * 2)) {
                  const ox = o.center.x, oy = o.center.y;
                  // Layered foliage
                  ctx.fillStyle = o.color;
                  ctx.beginPath(); ctx.arc(ox, oy - 15, o.radius, 0, Math.PI * 2); ctx.fill();
                  ctx.fillStyle = 'rgba(21, 128, 61, 0.8)'; // Darker inner
                  ctx.beginPath(); ctx.arc(ox, oy - 15, o.radius * 0.7, 0, Math.PI * 2); ctx.fill();
                  ctx.fillStyle = 'rgba(255,255,255,0.1)';
                  ctx.beginPath(); ctx.arc(ox - o.radius * 0.2, oy - 30, o.radius * 0.4, 0, Math.PI * 2); ctx.fill();
              }
          }
      });

      // Particles
      const now_p = Date.now();
      // Optimization: REDUCED particle limit to 60 for better clash performance
      const MAX_PARTICLES_TO_DRAW = 60;
      let drawnCount = 0;
      
      particlesRef.current.forEach((p, i) => {
          if (drawnCount >= MAX_PARTICLES_TO_DRAW) return;
          if (!isPointInView(p.pos.x, p.pos.y, 100)) return;
          
          // Optimization: Skip very faint particles even earlier
          if (p.life < 0.4) return;
          drawnCount++;
          
          // Fading effect based on life
          ctx.globalAlpha = Math.max(0, p.life);
          
          if (p.type === 'ripple') {
              ctx.strokeStyle = p.color;
              ctx.lineWidth = 4 * p.life;
              ctx.beginPath();
              ctx.arc(p.pos.x, p.pos.y, (1 - p.life) * PROJECTILE_EXPLOSION_RADIUS * 1.5, 0, Math.PI * 2);
              ctx.stroke();
          } else if (p.type === 'slash') {
              ctx.fillStyle = p.color;
              ctx.fillRect(p.pos.x, p.pos.y, 4, 4);
          } else if (p.type === 'tower_dust') {
              ctx.fillStyle = '#cbd5e1'; // Debris color
              ctx.beginPath();
              ctx.arc(p.pos.x, p.pos.y, 3 * p.life, 0, Math.PI * 2);
              ctx.fill();
          } else if (p.type === 'text' && p.text) {
              ctx.fillStyle = p.color;
              ctx.font = 'bold 24px Inter'; // Larger font for visibility
              ctx.textAlign = 'center';
              ctx.shadowBlur = 4; ctx.shadowColor = 'black'; // Add shadow for contrast
              ctx.fillText(p.text, p.pos.x, p.pos.y);
              ctx.shadowBlur = 0;
          } else {
              ctx.fillStyle = p.color;
              ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, 2, 0, Math.PI * 2); ctx.fill();
          }
          ctx.globalAlpha = 1.0;
      });

      // Ghost Preview (Architect Mode)
      if (isPlacingWall || isPlacingGate || isPlacingTower) {
        const cv = canvasRef.current;
        if (!cv) return;
        
        let targetX = mouseWorldPosRef.current.x;
        let targetY = mouseWorldPosRef.current.y;

        // Axis locking for preview
        if (isMouseDownRef.current && (isPlacingWall || isPlacingGate) && placementStartPosRef.current && placementAxisRef.current) {
            if (placementAxisRef.current === 'x') {
                targetY = placementStartPosRef.current.y;
            } else if (placementAxisRef.current === 'y') {
                targetX = placementStartPosRef.current.x;
            }
        }

        const snapX = Math.floor(targetX / GRID_SIZE) * GRID_SIZE;
        const snapY = Math.floor(targetY / GRID_SIZE) * GRID_SIZE;
        const finalX = snapX + GRID_SIZE/2;
        const finalY = snapY + GRID_SIZE/2;

        let rotation = 0;
        if (isPlacingWall || isPlacingGate) {
          if (placementAxisRef.current === 'x') {
            rotation = 0;
          } else if (placementAxisRef.current === 'y') {
            rotation = 90;
          } else if (lastWallPosRef.current) {
            const dx = Math.abs(finalX - lastWallPosRef.current.x);
            const dy = Math.abs(finalY - lastWallPosRef.current.y);
            if (dy > dx) rotation = 90;
          }
        }
        
        ctx.save();
        ctx.translate(finalX, finalY);
        if (rotation !== 0) ctx.rotate(rotation * Math.PI / 180);
        
        // Check for overlap for visual feedback
        const isOverlapping = towersRef.current.some(t => {
            const dx = Math.abs(t.pos.x - finalX);
            const dy = Math.abs(t.pos.y - finalY);
            return dx < (GRID_SIZE - GRID_MARGIN) && dy < (GRID_SIZE - GRID_MARGIN);
        });

        ctx.globalAlpha = 0.5;
        ctx.fillStyle = isOverlapping ? '#ef4444' : '#d4a373';
        
        if (isPlacingWall) {
          ctx.fillRect(-DRAW_LENGTH/2, -18, DRAW_LENGTH, 36);
          ctx.strokeStyle = 'white'; ctx.lineWidth = 2;
          ctx.strokeRect(-DRAW_LENGTH/2, -18, DRAW_LENGTH, 36);
        } else if (isPlacingGate) {
          ctx.fillRect(-DRAW_LENGTH/2, -22, DRAW_LENGTH, 44);
          ctx.strokeStyle = 'white'; ctx.lineWidth = 2;
          ctx.strokeRect(-DRAW_LENGTH/2, -22, DRAW_LENGTH, 44);
        } else if (isPlacingTower) {
          // Tower ghost - Detailed based on empire
          ctx.fillRect(-35, -50, 70, 70); // Base
          ctx.strokeStyle = 'white'; ctx.lineWidth = 2;
          ctx.strokeRect(-35, -50, 70, 70);
          
          // Simplified roof preview
          if (initialEmpire.id === 'rim') {
            ctx.beginPath(); ctx.moveTo(-45, -50); ctx.lineTo(0, -100); ctx.lineTo(45, -50); ctx.fill();
          } else if (initialEmpire.id === 'fim') {
            ctx.beginPath(); ctx.moveTo(-40, -50); ctx.lineTo(-25, -85); ctx.lineTo(25, -85); ctx.lineTo(40, -50); ctx.fill();
            ctx.beginPath(); ctx.moveTo(-25, -85); ctx.lineTo(0, -110); ctx.lineTo(25, -85); ctx.fill();
          } else {
            ctx.beginPath(); ctx.arc(0, -50, 30, Math.PI, 0); ctx.fill();
          }
        }
        ctx.restore();
      }

      // World border
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 8; ctx.setLineDash([20,10]);
      ctx.strokeRect(0, 0, worldSizeRef.current, worldSizeRef.current); ctx.setLineDash([]);
      
      ctx.restore(); // Restore from camera pan and zoom state

      // NEW: Underground Tint Overlay
      if (playerRef.current?.isUnderground) {
        ctx.fillStyle = 'rgba(62, 39, 35, 0.45)'; // Brownish dirt tint
        ctx.fillRect(0, 0, w, h);
      }

      // Spectator HUD Overlay
      if (isSpectatorRef.current) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(w/2 - 100, 20, 200, 40);
        ctx.fillStyle = '#ff4444';
        ctx.font = 'bold 14px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('SPECTATOR MODE', w/2, 45);
        
        ctx.fillStyle = 'white';
        ctx.font = '10px Inter';
        ctx.fillText(`ZOOM: ${cameraZoomRef.current.toFixed(1)}x (Use Wheel)`, w/2, 75);
      }

      requestAnimationFrame(render);

      // FPS Calculation
      framesRef.current++;
      const now = performance.now();
      if (now - lastTimeRef.current >= 1000) {
        fpsRef.current = Math.round((framesRef.current * 1000) / (now - lastTimeRef.current));
        setFps(fpsRef.current);
        framesRef.current = 0;
        lastTimeRef.current = now;
      }
    };
    const rid = requestAnimationFrame(render); return () => cancelAnimationFrame(rid);
  }, [myId, nickname, isPlacingWall, isPlacingGate, isPlacingTower, gameState]);

  const updateGarrisonMode = (id: string, mode: 'HOLD' | 'HUNT' | 'RECALL') => {
    const g = garrisonsRef.current.find(g => g.id === id);
    if (g) {
      g.mode = mode;
      setPlayerGarrisons([...garrisonsRef.current.filter(g => g.ownerId === myId)]);
    }
  };

  // NEW: SVG Shovel Component for UI
  const ShovelIcon = ({ isSuper = false, className = "w-6 h-6" }) => (
    <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Centered Shovel Geometry */}
      <path d="M12 18L12 4" stroke="#78350f" strokeWidth="2.5" strokeLinecap="round"/> {/* Handle */}
      <path d="M10 4L14 4" stroke="#78350f" strokeWidth="2" strokeLinecap="round"/> {/* Top T-Bar */}
      <path d="M8 16L12 21L16 16L8 16Z" fill={isSuper ? "#fbbf24" : "#cbd5e1"} stroke="#451a03" strokeWidth="1.5" strokeLinejoin="round"/> {/* Blade */}
    </svg>
  );

  return (
    <div className='relative w-full h-screen overflow-hidden bg-slate-900 font-sans text-white select-none'>
      
      {/* MINECRAFT STYLE INVENTORY UI - TOP LEVEL Z-INDEX */}
      {gameState === 'GAME_ACTIVE' && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center bg-[#8b8b8b] border-2 border-[#373737] p-1 pointer-events-auto z-[9999]" style={{boxShadow: 'inset 2px 2px 0px 0px #ffffff, inset -2px -2px 0px 0px #555555'}}>
          {/* Dynamically size based on items, min 3 slots */}
          {Array.from({length: Math.max(3, playerRef.current?.shovelUses && playerRef.current.shovelUses > 0 ? 3 : 3)}).map((_, i) => {
            const isActive = activeSlot === i;
            
            // Logic to determine what's in the slot
            let icon = null;
            let uses = 0;
            let maxUses = 10;
            
            if (i === 0) {
              icon = '⚔️';
            } else if (i === 1 && playerRef.current?.shovelUses && playerRef.current.shovelUses > 0) {
              const isSuper = playerRef.current.shovelUses > 10 || playerRef.current.shovelUses === 30;
              icon = (
                <div className="relative flex items-center justify-center w-full h-full">
                  {isSuper && <span className="absolute text-[10px] -top-1 -left-1 z-10">✨</span>}
                  <ShovelIcon isSuper={isSuper} className="w-8 h-8" />
                </div>
              );
              uses = playerRef.current.shovelUses;
              maxUses = isSuper ? 30 : 10;
            }

            return (
              <div 
                key={i}
                onClick={() => { 
                  setActiveSlot(i);
                  const p = playerRef.current;
                  if (p) {
                    if (i === 0) p.equippedItem = 'sword';
                    else if (i === 1 && p.shovelUses && p.shovelUses > 0) p.equippedItem = (p.shovelUses > 10 || p.shovelUses === 30) ? 'super_shovel' : 'shovel';
                    else p.equippedItem = 'sword';
                  }
                }}
                className="w-10 h-10 bg-[#8b8b8b] relative cursor-pointer flex items-center justify-center text-xl select-none hover:bg-white/10"
                style={{
                  border: '2px solid',
                  borderColor: '#373737 #ffffff #ffffff #373737', // Minecraft slot indent
                  marginLeft: i > 0 ? '-2px' : '0' // Overlap borders slightly like in MC
                }}
              >
                {/* Active Slot Highlight */}
                {isActive && (
                  <div className="absolute -inset-[3px] border-4 border-white pointer-events-none z-20 shadow-[0_0_10px_rgba(255,255,255,0.5)]" />
                )}
                
                {icon}

                {/* Durability Bar */}
                {icon && uses > 0 && (
                  <div className="absolute bottom-0.5 left-0.5 right-0.5 h-1 bg-black/80 z-10">
                    <div 
                      className="h-full" 
                      style={{
                        width: `${(uses / maxUses) * 100}%`,
                        backgroundColor: (uses / maxUses) > 0.5 ? '#22c55e' : ((uses / maxUses) > 0.2 ? '#eab308' : '#ef4444')
                      }}
                    />
                  </div>
                )}
                
                {/* Slot Number Hint */}
                <div className="absolute top-0 left-0.5 text-[8px] font-bold text-white/30 z-10">{i + 1}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Connection Loss Overlay */}
      {!socketConnected && (gameState === 'GAME_ACTIVE' || gameState === 'LOBBY_WAITING') && (
        <div className='absolute inset-0 bg-slate-900/60 backdrop-blur-md flex flex-col items-center justify-center z-[300] animate-in fade-in duration-300'>
          <div className='bg-red-500/10 border border-red-500/20 px-10 py-8 rounded-[3rem] flex flex-col items-center gap-6 shadow-[0_0_50px_rgba(239,68,68,0.1)]'>
            <div className='w-20 h-20 rounded-3xl bg-red-500/20 flex items-center justify-center text-red-500 animate-pulse'>
              <WifiOff size={40} />
            </div>
            <div className='text-center'>
              <h2 className='text-4xl font-black text-white uppercase tracking-tighter mb-2'>{t.connectionLost || 'CONNECTION LOST'}</h2>
              <p className='text-red-400 font-bold text-xs uppercase tracking-widest animate-pulse'>{t.reconnecting || 'RECONNECTING TO BATTLE...'}</p>
            </div>
            <button 
              onClick={() => {
                if (socketRef.current) {
                  socketRef.current.connect();
                } else {
                  window.location.reload();
                }
              }}
              className='mt-4 px-8 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl font-black text-sm uppercase tracking-widest transition-all active:scale-95'
            >
              {t.tryNow || 'TRY RECONNECT NOW'}
            </button>
          </div>
        </div>
      )}

      {queuePosition !== null && (
        <div className='absolute inset-0 bg-slate-900/90 backdrop-blur-2xl flex flex-col items-center justify-center p-6 z-[200] animate-in fade-in duration-500'>
          <div className='w-24 h-24 border-8 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-8 shadow-[0_0_50px_rgba(99,102,241,0.2)]'></div>
          <h2 className='text-5xl font-black text-white uppercase tracking-tighter mb-4 text-center'>{t.serverFull || 'Server Full'}</h2>
          <div className='bg-indigo-500/10 border border-indigo-500/20 px-8 py-4 rounded-[2rem] text-center mb-6'>
            <p className='text-slate-400 font-bold uppercase tracking-widest text-xs mb-2'>{t.pleaseWait || 'Please wait'}</p>
            <p className='text-3xl font-black text-indigo-400'>{t.yourPosition || 'Your position'}: {queuePosition}</p>
          </div>
          <p className='text-slate-500 font-bold uppercase tracking-[0.2em] text-[10px] animate-pulse'>{t.autoJoinWhenFree || 'Auto-joining when free...'}</p>
        </div>
      )}

      <canvas 
        ref={canvasRef} 
        className='block w-full h-full' 
        style={{ cursor: isSpectator ? (isDraggingCamera ? 'grabbing' : 'grab') : (isPlacingWall || isPlacingGate ? 'crosshair' : 'default') }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleCanvasClick}
        onWheel={(e) => {
          if (!isSpectator) return;
          const minZoom = 0.2;
          const maxZoom = 3.0;
          setCameraZoom(prev => Math.max(minZoom, Math.min(maxZoom, prev - e.deltaY * 0.001)));
        }}
        onTouchStart={handleCanvasClick}
      />
      
      {/* Password Modal */}
      {passwordModalRoom && (
        <div className='absolute inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-6 z-[200] animate-in fade-in duration-300'>
          <div className='bg-slate-900 border border-white/10 rounded-[2.5rem] p-8 md:p-12 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-300'>
            <div className='flex items-center gap-4 mb-8'>
              <div className='w-12 h-12 rounded-2xl bg-amber-500/20 flex items-center justify-center text-amber-500'>
                <Shield size={24} />
              </div>
              <div>
                <h2 className='text-2xl font-black text-white uppercase tracking-tighter'>{t.passwordRequired || 'Enter Password'}</h2>
                <p className='text-slate-500 font-bold text-xs uppercase tracking-widest'>{passwordModalRoom.name}</p>
              </div>
            </div>

            <div className='space-y-6'>
              <div>
                <label className='text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-2'>{t.roomPassword || 'Password'}</label>
                <input 
                  type='password' 
                  autoFocus
                  value={passwordInput} 
                  onChange={(e) => setPasswordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitJoinRequest(passwordModalRoom.id, passwordInput);
                    if (e.key === 'Escape') setPasswordModalRoom(null);
                  }}
                  className='w-full bg-slate-850 border border-white/5 rounded-2xl px-6 py-4 text-white font-bold focus:outline-none focus:border-indigo-500/50 transition-all placeholder:text-slate-700'
                  placeholder='••••••'
                />
              </div>

              <div className='flex flex-col gap-3'>
                <button 
                  onClick={() => submitJoinRequest(passwordModalRoom.id, passwordInput)} 
                  className='w-full py-5 bg-indigo-600 rounded-2xl font-black text-lg hover:bg-indigo-500 transition-all active:scale-95 shadow-lg shadow-indigo-500/20'
                >
                  {t.joinRoom || 'Join Battle'}
                </button>
                <button 
                  onClick={() => setPasswordModalRoom(null)} 
                  className='w-full py-3 text-slate-500 font-bold hover:text-white transition-all text-xs uppercase tracking-widest'
                >
                  {t.cancel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {gameState === 'CONNECTING' && (
        <div className='absolute inset-0 bg-slate-900/95 backdrop-blur-xl flex flex-col items-center justify-center p-6 z-[110]'>
          <div className='w-24 h-24 border-8 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-8'></div>
          <h2 className='text-4xl font-black text-white uppercase tracking-tighter mb-2 animate-pulse'>{t.enteringBattle}</h2>
          <p className='text-slate-400 font-bold uppercase tracking-widest text-xs'>{t.syncingWithServer}</p>
          
          <div className='mt-12 p-6 bg-slate-800/50 rounded-3xl border border-white/10 text-center'>
            <p className='text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] mb-3'>{t.networkDebugger}</p>
            <div className='flex items-center gap-3 bg-slate-900/80 px-4 py-2 rounded-xl'>
              <span className='w-2 h-2 rounded-full bg-emerald-500 animate-pulse' />
              <p className='text-xs font-mono text-emerald-400 uppercase'>{lastEvent || t.waitingForSultan}</p>
            </div>
          </div>

          <button 
            onClick={() => { setGameState('MENU'); setIsJoiningRoom(false); }}
            className='mt-12 px-8 py-3 bg-slate-800 text-slate-400 rounded-2xl font-black hover:bg-red-500/20 hover:text-red-400 transition-all'
          >
            {t.abortMission}
          </button>
        </div>
      )}

      {gameState === 'MENU' && (
        <div className='absolute inset-0 bg-slate-900 flex items-center justify-center p-4 md:p-6 overflow-y-auto z-[100] custom-scrollbar'>
          <div className='absolute top-4 left-4 md:top-8 md:left-8 flex items-center gap-4 z-[110]'>
            {onBack && (
              <button 
                onClick={onBack}
                className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors group"
              >
                <div className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-all">
                  <ArrowLeft size={18} className="md:w-5 md:h-5" />
                </div>
                <span className="font-bold uppercase tracking-widest text-[9px] md:text-[10px] hidden sm:block">{t.backToMenu}</span>
              </button>
            )}
          </div>
          <div className='absolute top-4 right-4 md:top-8 md:right-8 bg-indigo-500/10 border border-indigo-500/20 px-3 py-1.5 md:px-4 md:py-2 rounded-xl md:rounded-2xl backdrop-blur-md flex items-center gap-2 md:gap-3 z-[110]'>
            <div className='w-1.5 h-1.5 md:w-2 md:h-2 rounded-full bg-emerald-500 animate-pulse' />
            <span className='text-[8px] md:text-[10px] font-black uppercase tracking-widest text-indigo-400'>{t.online}: {serverCapacity.active} / {serverCapacity.max}</span>
          </div>
          {!isCreatingRoom ? (
            <div className='w-full max-w-2xl animate-in fade-in zoom-in duration-500 py-16 md:py-0'>
              <div className='text-center mb-8 md:mb-12'>
                <div className="flex flex-col md:flex-row items-center justify-center gap-3 md:gap-4 mb-4">
                  <div className="w-12 h-12 md:w-16 md:h-16 rounded-full border-2 border-white/20 overflow-hidden shadow-lg flex-shrink-0">
                    <img 
                      src={initialEmpire.id === 'rim' ? '/rim.png' : initialEmpire.id === 'tim' ? '/tim.jpg' : '/fim.png'} 
                      alt="Empire" 
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <h1 className='text-4xl sm:text-6xl md:text-8xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400 uppercase tracking-tighter'>
                     Empires.io
                   </h1>
                </div>
                <p className='text-slate-400 font-bold uppercase tracking-[0.2em] md:tracking-[0.3em] text-[10px] md:text-xs px-4'>
                  {initialEmpire.id === 'rim' ? 'Imperator\'s' : initialEmpire.id === 'tim' ? 'Sultan\'s' : 'Emperor\'s'} Edition • Online Battle Royale
                </p>
              </div>

                <div className='bg-slate-800/50 backdrop-blur-xl border border-white/10 rounded-[2rem] md:rounded-[3rem] p-5 md:p-10 mb-8 shadow-2xl'>
                <div className='flex flex-col md:flex-row items-center gap-4 md:gap-6 mb-6 md:mb-8'>
                    <div className='flex-1 w-full p-3 md:p-4 bg-slate-900/50 rounded-2xl md:rounded-3xl border border-white/5 flex items-center gap-3 md:gap-4'>
                        <div className='w-10 h-10 md:w-14 md:h-14 rounded-xl md:rounded-2xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 flex-shrink-0'><Users size={20} className="md:w-7 md:h-7" /></div>
                        <div className='flex-1'>
                            <label className='text-[8px] md:text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-1'>{empireTitles.nickname}</label>
                            <input 
                            type='text' 
                            value={nickname} 
                            onChange={(e) => { setNickname(e.target.value); localStorage.setItem('janissary_nickname', e.target.value); }}
                            className='w-full bg-transparent text-xl md:text-2xl font-black focus:outline-none placeholder:text-slate-700' 
                            placeholder={t.commanderName}
                            />
                        </div>
                    </div>
                    <button onClick={() => setIsCreatingRoom(true)} className='w-full md:w-auto px-8 md:px-10 py-4 md:py-6 bg-indigo-600 rounded-2xl md:rounded-[2rem] font-black text-lg md:text-xl hover:bg-indigo-500 transition-all active:scale-95 shadow-lg shadow-indigo-500/20'>
                        {t.createRoom}
                    </button>
                </div>

                <div className='mb-4 md:mb-8'>
                    <div className='flex items-center justify-between mb-4 px-2'>
                        <div className='flex items-center gap-2 md:gap-3'>
                          <h3 className='text-[10px] md:text-sm font-black uppercase tracking-widest text-slate-500'>{t.activeRooms}</h3>
                          <span className={`text-[8px] md:text-[10px] px-2 py-0.5 rounded-full font-bold ${networkStatus === 'Ready' ? 'bg-emerald-500/20 text-emerald-400' : networkStatus === 'Error' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                            {networkStatus === 'Ready' ? t.online.toUpperCase() : networkStatus}
                          </span>
                        </div>
                        <button 
                          onClick={() => socketRef.current?.emit('get_room_list')}
                          className='flex items-center gap-1 md:gap-2 text-[8px] md:text-[10px] text-emerald-500 font-bold uppercase hover:text-emerald-400 transition-colors'>
                          <RefreshCw size={10} className={cn("md:w-3 md:h-3", isJoiningRoom ? 'animate-spin' : '')} />
                          {t.refreshList}
                        </button>
                    </div>
                    <div className='grid grid-cols-1 gap-2 md:gap-3 max-h-48 md:max-h-64 overflow-y-auto pr-2 custom-scrollbar'>
                        {(discoveredRooms || []).length > 0 ? (discoveredRooms || []).map(room => (
                            <button key={room.id} onClick={() => joinRoom(room)} className='flex items-center justify-between bg-slate-900/80 hover:bg-slate-700 p-3 md:p-5 rounded-2xl md:rounded-3xl border border-white/5 transition-all group'>
                                <div className='flex items-center gap-3 md:gap-4 overflow-hidden'>
                                    <div className='w-8 h-8 md:w-10 md:h-10 rounded-full bg-slate-800 flex items-center justify-center font-black text-indigo-400 group-hover:scale-110 transition-transform flex-shrink-0'>{room.name[0]}</div>
                                    <div className='text-left overflow-hidden'>
                                        <div className='font-black text-sm md:text-lg uppercase tracking-tight truncate'>{room.name}</div>
                                        <div className='text-[8px] md:text-[10px] text-slate-500 font-bold uppercase truncate'>{room.status} • {room.limit || room.maxPlayers || 10} Max</div>
                                    </div>
                                </div>
                                <div className='flex items-center gap-2 md:gap-4 flex-shrink-0'>
                                    <div className='text-right'>
                                        <div className='text-[10px] md:text-sm font-black text-white'>{(room.players || []).length}/{room.limit || room.maxPlayers || 10}</div>
                                        <div className='text-[8px] md:text-[10px] text-indigo-400 font-bold uppercase'>{empireTitles.plural}</div>
                                    </div>
                                    {room.password && <Shield size={12} className='text-amber-500 md:w-3.5 md:h-3.5' />}
                                    <Zap size={14} className='text-yellow-500 md:w-4.5 md:h-4.5' />
                                </div>
                            </button>
                        )) : (
                            <div className='py-8 md:py-12 text-center bg-slate-900/40 rounded-2xl md:rounded-3xl border border-white/5 border-dashed'>
                                <p className='text-slate-600 font-bold uppercase tracking-widest text-[10px] md:text-xs px-4'>{t.noActiveBattles}</p>
                                <p className='text-[8px] md:text-[10px] text-slate-700 font-bold px-4'>{t.firstSultanHost}</p>
                            </div>
                        )}
                    </div>
                </div>
              </div>
            </div>
          ) : (
            <div className='w-full max-w-lg bg-slate-800 border border-white/10 rounded-[3rem] p-10 animate-in slide-in-from-bottom-8'>
              <h2 className='text-4xl font-black mb-8 uppercase tracking-tighter'>{t.hostRoom}</h2>
              <div className='flex flex-col gap-6 mb-10'>
                <div>
                  <label className='text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-2'>{t.roomName}</label>
                  <input type='text' value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })}
                    className='w-full bg-slate-900 border border-white/10 p-5 rounded-2xl font-bold focus:outline-none focus:border-indigo-500 text-xl' placeholder='Imperial Battle'/>
                </div>
                <div>
                  <label className='text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-2'>{t.passwordOptional}</label>
                  <input type='password' value={roomForm.password} onChange={(e) => setRoomForm({ ...roomForm, password: e.target.value })}
                    className='w-full bg-slate-900 border border-white/10 p-5 rounded-2xl font-bold focus:outline-none focus:border-indigo-500' placeholder='Private Entry'/>
                </div>
                <div>
                  <label className='text-[10px] text-slate-500 font-black uppercase tracking-widest block mb-2'>{t.maxPlayers}: {roomForm.limit}</label>
                  <input type='range' min='2' max='10' value={roomForm.limit} onChange={(e) => setRoomForm({ ...roomForm, limit: parseInt(e.target.value) })}
                    className='w-full h-2 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-indigo-500'/>
                </div>
              </div>
              <div className='flex flex-col gap-4'>
                <button onClick={startLobby} className='w-full py-6 bg-indigo-600 rounded-3xl font-black text-xl hover:bg-indigo-500 transition-all'>{t.startLobby}</button>
                <button onClick={() => setIsCreatingRoom(false)} className='w-full py-2 text-slate-500 font-bold hover:text-white transition-all text-xs'>{t.cancel}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {gameState === 'CONNECTING' && (
        <div className='absolute inset-0 bg-slate-900/95 backdrop-blur-md flex flex-col items-center justify-center p-6 z-[100]'>
          <div className='flex flex-col items-center gap-6 animate-in fade-in zoom-in-95'>
            <div className='relative'>
              <div className='absolute inset-0 blur-3xl bg-indigo-500/20 rounded-full animate-pulse'></div>
              <Loader2 className='animate-spin text-indigo-500 relative' size={64} />
            </div>
            <div className='text-center'>
              <h2 className='text-3xl font-black text-white uppercase tracking-tighter'>{t.enteringBattle}...</h2>
              <p className='text-slate-400 font-bold text-xs uppercase tracking-widest mt-2'>{t.syncingWithServer}</p>
              
              <div className='mt-8 p-6 bg-black/40 rounded-[2rem] border border-white/5 text-[10px] font-mono text-indigo-400 w-64 text-left space-y-2 shadow-2xl'>
                <div className='flex items-center justify-between border-b border-white/5 pb-2'>
                  <span className='text-slate-500 uppercase font-black tracking-tighter'>Socket Status</span>
                  <span className={socketRef.current?.connected ? 'text-emerald-400' : 'text-red-400'}>{socketRef.current?.connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
                </div>
                <div>ID: <span className='text-slate-300'>{socketRef.current?.id || 'NOT CONNECTED'}</span></div>
                <div>LATEST: <span className='text-slate-300'>{lastEvent}</span></div>
                {isJoiningRoom && <div className='animate-pulse text-indigo-300'>WAITING FOR HANDSHAKE...</div>}
              </div>
            </div>
            <button onClick={() => { setGameState('MENU'); ENGINE_STATE = 'MENU'; setIsJoiningRoom(false); setIsMultiplayer(false); }} className='mt-8 px-8 py-3 bg-white/5 hover:bg-white/10 text-slate-400 rounded-2xl font-black text-xs uppercase tracking-widest transition-all'>{t.abortMission}</button>
          </div>
        </div>
      )}

      {gameState === 'LOBBY_WAITING' && (
        <div className='absolute inset-0 z-[100] flex flex-col items-center justify-between pointer-events-none'>
          {/* Top Header - Compact Grid */}
          <div className='w-full bg-slate-900/60 backdrop-blur-md border-b border-white/10 p-2 md:p-4 pointer-events-auto'>
            <div className='max-w-7xl mx-auto flex justify-between items-center gap-2'>
              <div className='flex items-center gap-2 md:gap-4'>
                <div className='flex flex-col md:mr-8 flex-shrink-0'>
                  <h2 className='text-sm md:text-xl font-black text-white uppercase tracking-tighter'>{t.waitingArena}</h2>
                  <p className='text-indigo-400 font-bold uppercase tracking-widest text-[6px] md:text-[8px] truncate max-w-[80px] md:max-w-none'>{currentRoom?.name || t.gameTitle}</p>
                </div>
              </div>

              <div className='flex-1 grid grid-rows-2 grid-flow-col gap-1 md:gap-2 overflow-x-auto no-scrollbar py-1'>
                {(lobbyPlayers || []).map((p) => (
                  <div key={p.id} className='bg-slate-800/80 backdrop-blur border border-white/10 rounded-lg md:rounded-xl px-2 py-1 md:px-3 md:py-1.5 flex items-center gap-1.5 md:gap-2 min-w-[80px] md:min-w-[110px] max-h-[32px] md:max-h-[44px] transition-all hover:bg-slate-700 relative group'>
                    <div className={`w-5 h-5 md:w-7 md:h-7 rounded-md md:rounded-lg flex items-center justify-center relative ${p.isHost ? 'bg-yellow-500/20 text-yellow-500' : 'bg-indigo-500/20 text-indigo-400'}`}>
                      {p.isHost && <Crown className='absolute -top-1.5 -right-1.5 text-yellow-500 animate-pulse md:w-2.5 md:h-2.5' size={8} />}
                      <Users size={10} className="md:w-3.5 md:h-3.5" />
                    </div>
                    <div className='flex flex-col overflow-hidden'>
                      <div className='text-[7px] md:text-[9px] font-black uppercase truncate text-white max-w-[50px] md:max-w-[70px]'>{p.name}</div>
                      <div className='text-[5px] md:text-[6px] text-slate-500 font-mono tracking-tighter uppercase'>{(empireTitles.plural || 'Bey').slice(0, 4).toUpperCase()} {p.id.slice(0, 4)}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className='flex items-center gap-2 md:gap-4 ml-2 md:ml-8 flex-shrink-0'>
                <div className='hidden lg:block text-[10px] font-black uppercase tracking-widest text-slate-400'>
                   {t.wasdToTest}
                </div>
                <button 
                  onClick={leaveRoom} 
                  className='px-3 py-1.5 md:px-4 md:py-2 bg-red-600/20 border border-red-500/30 text-red-400 rounded-lg md:rounded-xl font-black text-[8px] md:text-[10px] uppercase tracking-widest hover:bg-red-600 hover:text-white transition-all active:scale-95'
                >
                  {t.abandon}
                </button>
              </div>
            </div>
          </div>

          {/* Center Info */}
          <div className='flex-1 flex flex-col items-center justify-center mt-10 md:mt-20 px-4'>
             {!isHost && countdown === null && (
               <div className='px-6 py-3 md:px-10 md:py-4 bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-full text-white font-black text-sm md:text-lg text-center uppercase tracking-[0.1em] md:tracking-[0.2em] animate-pulse shadow-2xl'>
                 {empireTitles.waiting}
               </div>
             )}
             
             {countdown !== null && (
                <div className='fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none'>
                  <div className='flex flex-col items-center bg-black/40 backdrop-blur-xl px-10 py-6 md:px-20 md:py-10 rounded-[2rem] md:rounded-[4rem] border border-white/10 animate-in zoom-in duration-300 shadow-[0_0_100px_rgba(16,185,129,0.2)] mx-4'>
                    <div className='text-sm md:text-xl text-indigo-400 font-black uppercase tracking-[0.2em] md:tracking-[0.4em] mb-2 md:mb-4 animate-pulse'>{t.battleStartsIn}</div>
                    <div className='text-8xl md:text-[12rem] leading-none font-black text-white tabular-nums drop-shadow-[0_0_50px_rgba(255,255,255,0.4)] animate-pulse'>{countdown}</div>
                  </div>
                </div>
             )}
          </div>

          {/* Bottom HUD */}
          <div className='absolute bottom-0 left-0 right-0 w-full p-4 md:p-10 flex flex-row items-end justify-between pointer-events-none z-[150]'>
            <div className='pointer-events-auto flex-shrink-0 scale-75 md:scale-100 origin-bottom-left'>
              <Joystick onMove={(x, y) => { joystickDir.current = { x, y }; }} />
            </div>

            {countdown === null && isHost && (
              <div className='pointer-events-auto px-2'>
                <button 
                  disabled={lobbyPlayers.length < 2}
                  onClick={() => {
                    if (socketRef.current && currentRoom) {
                      socketRef.current.emit('start_match_request', currentRoom.id);
                    }
                  }}
                  className={`px-8 py-4 md:px-16 md:py-6 rounded-[1.5rem] md:rounded-[2.5rem] font-black text-lg md:text-2xl uppercase tracking-widest transition-all shadow-2xl active:scale-95 ${
                    lobbyPlayers.length >= 2 
                      ? 'bg-indigo-600 text-white hover:bg-indigo-500 hover:shadow-indigo-500/20 border-b-4 md:border-b-8 border-indigo-900' 
                      : 'bg-slate-800 text-slate-600 cursor-not-allowed grayscale border-b-4 md:border-b-8 border-slate-950'
                  }`}
                >
                  {lobbyPlayers.length < 2 ? t.needPlayers : t.startBattle}
                </button>
              </div>
            )}

            {/* Minimap Bottom Right */}
            <div className='bg-slate-900/90 backdrop-blur border-2 md:border-4 border-slate-700 rounded-xl md:rounded-3xl overflow-hidden shadow-2xl pointer-events-none flex-shrink-0'>
               <canvas 
                width={MINIMAP_SIZE} 
                height={MINIMAP_SIZE} 
                className='w-24 h-24 sm:w-32 sm:h-32 md:w-44 md:h-44'
                ref={(el) => {
                  if (el) {
                    const ctx = el.getContext('2d');
                    if (ctx) {
                      ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
                      ctx.fillStyle = 'rgba(20, 83, 45, 0.4)';
                      ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
                      
                      const currentWorldSize = worldSizeRef.current;
                      const s = MINIMAP_SIZE / currentWorldSize;
                      
                      // Draw Villages
                      gameMapRef.current.villages.forEach(v => {
                        ctx.fillStyle = v.ownerId ? v.color : '#78350f';
                        const vs = 6 * s * (currentWorldSize / 1000); 
                        ctx.fillRect(v.pos.x * s - vs/2, v.pos.y * s - vs/2, vs, vs);
                        ctx.strokeStyle = 'white';
                        ctx.lineWidth = 1;
                        ctx.strokeRect(v.pos.x * s - vs/2, v.pos.y * s - vs/2, vs, vs);
                      });

                      // Draw obstacles
                      gameMapRef.current.obstacles.forEach(obs => {
                        ctx.fillStyle = obs.type === 'boulder' ? 'rgba(71, 85, 105, 0.6)' : 'rgba(21, 128, 61, 0.6)';
                        const mx = obs.center.x * s;
                        const my = obs.center.y * s;
                        ctx.beginPath();
                        ctx.arc(mx, my, 2, 0, Math.PI * 2);
                        ctx.fill();
                      });

                      // Draw towers - Fog of War
                      towersRef.current.forEach(t => { 
                        if (t.ownerId !== myId) return; // Only show local player's buildings
                        ctx.fillStyle = t.color;
                        const ts = 5;
                        ctx.fillRect(t.pos.x * s - ts / 2, t.pos.y * s - ts / 2, ts, ts);
                      });

                      // Draw players - Fog of War
                      entitiesRef.current.forEach(e => {
                        if (e.id !== myId) return; // Only show local player on minimap
                        e.units.forEach((u, i) => {
                          ctx.fillStyle = e.color;
                          const mx = u.pos.x * s;
                          const my = u.pos.y * s;
                          ctx.beginPath();
                          ctx.arc(mx, my, i === 0 ? 3 : 1.5, 0, Math.PI * 2);
                          ctx.fill();
                          if (i === 0) {
                            ctx.strokeStyle = 'white';
                            ctx.lineWidth = 1;
                            ctx.stroke();
                          }
                        });
                      });
                    }
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {gameState === 'MATCH_RESULTS' && (
        <div className={`absolute inset-0 ${matchResult?.isWinner ? 'bg-black/90' : 'bg-red-950/90'} backdrop-blur-xl flex flex-col items-center justify-center p-4 md:p-6 z-[100] overflow-y-auto custom-scrollbar`} style={!matchResult?.isWinner ? { backgroundColor: 'rgba(142, 28, 28, 0.9)' } : {}}>
          <div className={`w-full max-w-xs md:max-w-sm bg-slate-900 border ${matchResult?.isWinner ? 'border-emerald-500/30' : 'border-red-500/30'} rounded-[2rem] md:rounded-[3rem] p-5 md:p-6 text-center shadow-2xl relative overflow-hidden animate-in zoom-in duration-500 my-8 md:my-0`}>
            <div className={`absolute top-0 left-0 w-full h-1.5 md:h-2 bg-gradient-to-r ${matchResult?.isWinner ? 'from-emerald-500 to-teal-400' : 'from-red-800 to-red-600'}`}></div>
            
            <div className='relative mb-3 md:mb-4 mt-2'>
              <div className={`absolute inset-0 blur-2xl opacity-10 rounded-full ${matchResult?.isWinner ? 'bg-emerald-500' : 'bg-red-600'}`}></div>
              {matchResult?.isWinner ? (
                <Trophy size={48} className='mx-auto text-yellow-500 drop-shadow-[0_0_15px_rgba(234,179,8,0.4)] md:w-[60px] md:h-[60px]' />
              ) : (
                <Crown size={48} className='mx-auto text-red-500 shadow-red-500/50 md:w-[60px] md:h-[60px]' />
              )}
            </div>

            {(() => {
              const isWinner = matchResult?.isWinner;
              const titleText = isWinner ? empireTitles.victory : t.defeat;
              const titleColor = isWinner ? playerColor : "#c0392b";
              return (
                <>
                  <h2 className='text-2xl md:text-4xl font-black mb-1 uppercase tracking-tighter leading-tight md:leading-none' style={{ color: titleColor }}>
                    {titleText}
                  </h2>
                  <div className='font-black uppercase tracking-[0.1em] md:tracking-[0.15em] text-[9px] md:text-[11px] mb-4 md:mb-6 px-2'>
                    {isWinner ? (
                      <span className="text-emerald-400">{t.victoryMessage || 'You conquered the field.'}</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-red-400 font-bold">{t.youLost}</span>
                        <span className="text-red-500 font-black uppercase tracking-tighter text-[10px] md:text-xs mt-1 bg-red-600/20 py-1 px-3 rounded-full border border-red-500/20 inline-block mx-auto">
                          {t.wasKilledBy || 'Вас убил'}: <span className="text-white">"{matchResult?.winnerName || killerName || 'Unknown Commander'}"</span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className='grid grid-cols-2 gap-2 md:gap-3 mb-4 md:mb-6 px-1 md:px-0'>
                    <div className='bg-slate-800/50 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5'>
                      <div className='text-lg md:text-2xl font-black text-white mb-0.5'>{matchStats.kills}</div>
                      <div className='text-[7px] md:text-[8px] text-slate-500 font-black uppercase tracking-widest flex items-center justify-center gap-1'>⚔️ {t.eliminations}</div>
                    </div>
                    <div className='bg-slate-800/50 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5'>
                      <div className='text-lg md:text-2xl font-black text-white mb-0.5'>{matchStats.maxArmy}</div>
                      <div className='text-[7px] md:text-[8px] text-slate-500 font-black uppercase tracking-widest flex items-center justify-center gap-1'>🛡️ {t.maxArmyStat}</div>
                    </div>
                    <div className='bg-slate-800/50 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5'>
                      <div className='text-lg md:text-2xl font-black text-white mb-0.5'>{matchStats.towersBuilt}</div>
                      <div className='text-[7px] md:text-[8px] text-slate-500 font-black uppercase tracking-widest flex items-center justify-center gap-1'>🏰 {t.towersBuilt}</div>
                    </div>
                    <div className='bg-slate-800/50 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5'>
                      <div className='text-lg md:text-2xl font-black text-white mb-0.5'>{matchStats.duration}</div>
                      <div className='text-[7px] md:text-[8px] text-slate-500 font-black uppercase tracking-widest flex items-center justify-center gap-1'>⏱️ {t.duration}</div>
                    </div>
                  </div>
                </>
              );
            })()}

            <div className='flex flex-col gap-3 mt-2 px-2'>
              <button 
                disabled={hasVoted}
                onClick={voteRematch}
                className={`group px-4 py-3 rounded-xl md:rounded-2xl font-black text-[10px] md:text-xs uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 relative overflow-hidden ${hasVoted ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'}`}
              >
                {!hasVoted && <div className='absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-shimmer'></div>}
                {hasVoted ? t.voted : t.voteRematch}
                <span className='bg-black/20 px-2 py-0.5 rounded-full text-[9px] md:text-[10px] font-mono'>
                  {voteCount.voted || currentRoom?.rematchVotes?.length || 0}/{voteCount.total || currentRoom?.players?.length || 0}
                </span>
              </button>
              <div className="flex gap-2">
                {isSpectator && (
                  <button 
                    onClick={() => { setGameState('GAME_ACTIVE'); ENGINE_STATE = 'GAME_ACTIVE'; }} 
                    className='flex-1 px-4 py-3 bg-emerald-600 hover:bg-emerald-500 border border-emerald-400 rounded-xl md:rounded-2xl text-white font-black uppercase tracking-widest text-[10px] md:text-xs transition-all shadow-lg shadow-emerald-500/20'
                  >
                    {t.spectate}
                  </button>
                )}
                <button 
                  onClick={() => { leaveRoom(); setGameState('MENU'); ENGINE_STATE = 'MENU'; }}
                  className='flex-1 px-4 py-3 bg-white/5 hover:bg-red-600/20 border border-white/10 rounded-xl md:rounded-2xl text-slate-400 hover:text-red-400 font-black uppercase tracking-widest text-[10px] md:text-xs transition-all flex items-center justify-center gap-2'
                >
                  <LogOut size={14} />
                  {t.exitToLobby}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {gameState === 'GAME_ACTIVE' && (
        <>
          {/* Top Left Stats - Coins & Units */}
          <div className='absolute top-4 left-4 md:top-8 md:left-8 flex flex-col gap-1.5 md:gap-3 pointer-events-none z-[110] scale-[0.85] md:scale-100 origin-top-left'>
            <div className='flex items-center gap-2 md:gap-4 bg-slate-900/60 backdrop-blur-md border-2 border-white/10 p-1.5 md:p-3 rounded-xl md:rounded-[2rem] shadow-2xl animate-in slide-in-from-left duration-500'>
              <div className='w-8 h-8 md:w-14 md:h-14 rounded-lg md:rounded-3xl bg-amber-500/20 flex items-center justify-center text-base md:text-2xl shadow-inner border border-amber-500/20'>
                💰
              </div>
              <div className='flex flex-col pr-3 md:pr-8'>
                <span className='text-[7px] md:text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none mb-0.5'>{t.treasury || 'Treasury'}</span>
                <div className='flex items-baseline gap-1'>
                  <span className='text-lg md:text-3xl font-black text-white tabular-nums tracking-tighter'>{playerAkce}</span>
                  <span className='text-[7px] md:text-[10px] font-bold text-amber-500/80 uppercase tracking-tighter'>{getEmpireCurrency()}</span>
                </div>
              </div>
            </div>

            <div className='flex items-center gap-2 md:gap-4 bg-slate-900/60 backdrop-blur-md border-2 border-white/10 p-1.5 md:p-3 rounded-xl md:rounded-[2rem] shadow-2xl animate-in slide-in-from-left duration-700'>
              <div className='w-8 h-8 md:w-14 md:h-14 rounded-lg md:rounded-3xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 shadow-inner border border-indigo-500/20'>
                <Users size={16} className='md:w-7 md:h-7' />
              </div>
              <div className='flex flex-col pr-3 md:pr-8'>
                <span className='text-[7px] md:text-[10px] font-black text-slate-500 uppercase tracking-widest leading-none mb-0.5'>{t.armySize || 'Army Size'}</span>
                <div className='flex items-baseline gap-1'>
                  <span className='text-lg md:text-3xl font-black text-white tabular-nums tracking-tighter'>{score}</span>
                  <span className='text-[7px] md:text-[10px] font-bold text-indigo-400/80 uppercase tracking-tighter'>{t.warriors || 'Warriors'}</span>
                </div>
              </div>
            </div>

            {/* Match Timer & FPS */}
            <div className='flex items-center gap-2 md:gap-3 bg-slate-900/40 backdrop-blur-sm border border-white/5 p-1 md:p-2 rounded-lg md:rounded-2xl shadow-xl animate-in slide-in-from-left duration-1000'>
              <div className='text-[10px] md:text-base'>⏱️</div>
              <div className='flex flex-col'>
                <span className='text-[5px] md:text-[8px] font-black text-slate-500 uppercase tracking-widest leading-none mb-0.5'>{t.duration || 'Match Duration'}</span>
                <span className='text-[10px] md:text-lg font-black text-white tabular-nums leading-none'>
                  {Math.floor((Date.now() - startTimeRef.current) / 60000).toString().padStart(2, '0')}:
                  {Math.floor(((Date.now() - startTimeRef.current) % 60000) / 1000).toString().padStart(2, '0')}
                </span>
              </div>
              <div className='ml-2 pl-2 border-l border-white/10 flex flex-col'>
                <span className='text-[5px] md:text-[8px] font-black text-slate-500 uppercase tracking-widest leading-none mb-0.5'>FPS</span>
                <span className={`text-[10px] md:text-lg font-black tabular-nums leading-none ${fps > 55 ? 'text-emerald-400' : fps > 30 ? 'text-amber-400' : 'text-red-400'}`}>
                  {fps}
                </span>
              </div>
            </div>

            {/* Garrison (Split) UI - Interactive Controls */}
            <div className='flex flex-col gap-1.5 mt-1 md:mt-2 pointer-events-auto max-h-[40vh] overflow-y-auto custom-scrollbar pr-2'>
              {garrisonsRef.current.filter(g => g.ownerId === myId).map((g, idx) => (
                <div key={g.id} className='flex flex-col bg-slate-900/90 backdrop-blur-md border border-indigo-500/30 p-1.5 md:p-3 rounded-lg md:rounded-2xl shadow-xl animate-in slide-in-from-left duration-300 min-w-[120px] md:min-w-[180px]'>
                  <div className='flex items-center justify-between mb-1 md:mb-2'>
                    <div className='flex flex-col'>
                      <span className='text-[6px] md:text-[10px] font-black text-indigo-400 uppercase tracking-tighter leading-none'>#{idx + 1} {t.squad}</span>
                      <span className='text-[8px] md:text-xs font-bold text-white uppercase mt-0.5'>{g.mode === 'HOLD' ? t.hold : g.mode === 'HUNT' ? t.hunt : t.recall}</span>
                    </div>
                    <span className='px-1 py-0.5 bg-black/40 rounded text-[7px] md:text-[10px] font-mono text-white border border-white/5'>{g.units.length}U</span>
                  </div>
                  
                  <div className='grid grid-cols-3 gap-1 md:gap-2'>
                    <button 
                      onClick={() => { g.mode = 'HOLD'; }}
                      className={`p-1 md:p-2 rounded-md md:rounded-lg flex flex-col items-center justify-center gap-0.5 md:gap-1 transition-all ${g.mode === 'HOLD' ? 'bg-emerald-600 text-white shadow-lg' : 'bg-slate-800 text-slate-400'}`}
                    >
                      <Shield size={10} className='md:w-4 md:h-4' />
                      <span className='text-[6px] md:text-[8px] font-black uppercase tracking-tighter'>{t.hold}</span>
                    </button>
                    <button 
                      onClick={() => { g.mode = 'HUNT'; }}
                      className={`p-1 md:p-2 rounded-md md:rounded-lg flex flex-col items-center justify-center gap-0.5 md:gap-1 transition-all ${g.mode === 'HUNT' ? 'bg-red-600 text-white shadow-lg' : 'bg-slate-800 text-slate-400'}`}
                    >
                      <Sword size={10} className='md:w-4 md:h-4' />
                      <span className='text-[6px] md:text-[8px] font-black uppercase tracking-tighter'>{t.hunt}</span>
                    </button>
                    <button 
                      onClick={() => { g.mode = 'RECALL'; }}
                      className={`p-1 md:p-2 rounded-md md:rounded-lg flex flex-col items-center justify-center gap-0.5 md:gap-1 transition-all ${g.mode === 'RECALL' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-800 text-slate-400'}`}
                    >
                      <Zap size={10} className='md:w-4 md:h-4' />
                      <span className='text-[6px] md:text-[8px] font-black uppercase tracking-tighter'>{t.recall}</span>
                    </button>
                  </div>

                  <div className='w-full h-0.5 md:h-1 bg-slate-800 rounded-full mt-1.5 overflow-hidden'>
                    <div className='h-full bg-indigo-500 transition-all duration-500' style={{ width: `${Math.min(100, (g.units.length / 50) * 100)}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Error Message Toast */}
          {errorMessage && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[300] bg-red-600/90 border-2 border-red-400 text-white px-6 py-3 rounded-full font-black text-xs uppercase tracking-wider shadow-2xl animate-bounce pointer-events-none flex items-center gap-2">
              <span>⚠️</span> {errorMessage}
            </div>
          )}

          {isSpectator && (
            <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-3 pointer-events-none">
              <div className="px-6 py-3 bg-black/80 backdrop-blur-xl rounded-2xl border border-indigo-500/50 text-indigo-300 font-black uppercase tracking-[0.2em] animate-pulse shadow-2xl flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                {t.spectatorMode} • {cameraZoom.toFixed(1)}x
              </div>
              <button
                onClick={() => {
                  setShowExitConfirm(true);
                }}
                className="pointer-events-auto px-10 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-black shadow-xl border-b-4 border-red-900 active:scale-95 transition-all uppercase tracking-widest text-sm"
              >
                {t.exitToLobby}
              </button>
            </div>
          )}
          <div className='absolute bottom-4 right-4 md:bottom-10 md:right-10 flex flex-col gap-4 md:gap-6 items-end pointer-events-none z-[110]'>
            {/* Minimap Bottom Right - Active Game */}
            <div className='bg-slate-900/90 backdrop-blur border-2 md:border-4 border-slate-700 rounded-xl md:rounded-3xl overflow-hidden shadow-2xl flex-shrink-0'>
               <canvas 
                width={MINIMAP_SIZE} 
                height={MINIMAP_SIZE} 
                className='w-24 h-24 sm:w-32 sm:h-32 md:w-44 md:h-44'
                ref={(el) => {
                  if (el) {
                    const ctx = el.getContext('2d');
                    if (ctx) {
                      ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
                      ctx.fillStyle = 'rgba(20, 83, 45, 0.4)';
                      ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
                      
                      const currentWorldSize = worldSizeRef.current;
                      const s = MINIMAP_SIZE / currentWorldSize;

                      // Draw Villages
                      gameMapRef.current.villages.forEach(v => {
                        ctx.fillStyle = v.ownerId ? v.color : '#78350f';
                        const vs = 6 * s * (currentWorldSize / 1000); // Scale with world size
                        ctx.fillRect(v.pos.x * s - vs/2, v.pos.y * s - vs/2, vs, vs);
                        ctx.strokeStyle = 'white';
                        ctx.lineWidth = 1;
                        ctx.strokeRect(v.pos.x * s - vs/2, v.pos.y * s - vs/2, vs, vs);
                      });

                      // Draw Caravans
                      caravansRef.current.forEach(c => {
                        ctx.fillStyle = '#fbbf24';
                        ctx.beginPath();
                        ctx.arc(c.pos.x * s, c.pos.y * s, 3, 0, Math.PI * 2);
                        ctx.fill();
                      });

                      // Draw obstacles
                      gameMapRef.current.obstacles.forEach(obs => {
                        ctx.fillStyle = obs.type === 'boulder' ? 'rgba(71, 85, 105, 0.6)' : 'rgba(21, 128, 61, 0.6)';
                        const mx = obs.center.x * s;
                        const my = obs.center.y * s;
                        ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2); ctx.fill();
                      });

                      // Draw towers - Fog of War
                      towersRef.current.forEach(t => { 
                        if (t.ownerId !== myId) return; // Only show local player's buildings
                        ctx.fillStyle = t.color;
                        const ts = 5;
                        ctx.fillRect(t.pos.x * s - ts / 2, t.pos.y * s - ts / 2, ts, ts);
                      });

                      // Draw local player only (Fog of War Blackout)
                      const localEnt = entitiesRef.current.find(e => e.id === myId);
                      if (localEnt && localEnt.units && localEnt.units.length > 0) {
                        ctx.fillStyle = localEnt.color;
                        const mx = localEnt.units[0].pos.x * s;
                        const my = localEnt.units[0].pos.y * s;
                        ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fill();
                        ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();
                        
                        // Draw local units as small dots
                        localEnt.units.forEach((u, idx) => {
                          if (idx === 0) return;
                          ctx.beginPath(); ctx.arc(u.pos.x * s, u.pos.y * s, 1.5, 0, Math.PI * 2); ctx.fill();
                        });
                      }

                      // Draw local garrisons on minimap
                      const myGarrisons = garrisonsRef.current.filter(g => g.ownerId === myId);
                      myGarrisons.forEach((g, gIdx) => {
                        ctx.fillStyle = g.color;
                        const mx = g.pos.x * s;
                        const my = g.pos.y * s;
                        ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.fill();
                        ctx.strokeStyle = 'white'; ctx.lineWidth = 1; ctx.stroke();
                        
                        // Small icon based on mode
                        ctx.fillStyle = 'white';
                        ctx.font = '6px Arial';
                        ctx.textAlign = 'center';
                        let icon = '🛡️';
                        if (g.mode === 'HUNT') icon = '⚔️';
                        if (g.mode === 'RECALL') icon = '🏃';
                        ctx.fillText(icon, mx, my - 4);

                        // Garrison Number
                        ctx.fillStyle = '#fbbf24';
                        ctx.font = 'bold 8px Arial';
                        ctx.fillText(`${gIdx + 1}`, mx + 6, my + 3);
                      });
                    }
                  }
                }}
              />
            </div>

            <div className='flex gap-2 md:gap-4 items-center pointer-events-auto scale-75 md:scale-100 origin-bottom-right'>
              <button onClick={() => { setShowShop(!showShop); lastWallPosRef.current = null; }} className={`relative w-16 h-16 md:w-20 md:h-20 rounded-full border-2 md:border-4 flex flex-col items-center justify-center transition-all ${showShop ? 'bg-indigo-600 border-indigo-400' : 'bg-slate-900/60 border-slate-700'} active:scale-90 shadow-xl`}>
                <Sword size={24} className={cn("md:w-8 md:h-8", showShop ? 'text-white' : 'text-indigo-400')} /><span className='text-[7px] md:text-[8px] font-black uppercase tracking-tighter'>{t.actions}</span>
                <div className='absolute -top-2 -right-2 bg-slate-950 border border-white/20 rounded-md px-1.5 py-0.5 text-[8px] font-black text-white'>E</div>
              </button>
              {(isPlacingWall || isPlacingGate || isPlacingTower) && (
                <button 
                  onClick={() => { 
                    setIsPlacingWall(false); 
                    setIsPlacingGate(false); 
                    setIsPlacingTower(false);
                    lastWallPosRef.current = null; 
                  }}
                  className='relative w-16 h-16 md:w-20 md:h-20 bg-red-600 hover:bg-red-500 text-white rounded-full shadow-xl flex flex-col items-center justify-center border-2 md:border-4 border-white/20 transition-all active:scale-90 animate-in zoom-in duration-200'
                >
                  <span className="text-xl md:text-2xl font-black">✕</span>
                  <span className="text-[7px] md:text-[8px] font-black uppercase">{t.cancel}</span>
                  <div className='absolute -top-2 -right-2 bg-slate-950 border border-white/20 rounded-md px-1.5 py-0.5 text-[8px] font-black text-white'>ESC</div>
                </button>
              )}
              <button onClick={() => { if (playerRef.current) splitSwarm(playerRef.current); }} className='relative w-16 h-16 md:w-20 md:h-20 rounded-full border-2 md:border-4 flex flex-col items-center justify-center transition-all bg-indigo-600/20 border-indigo-500/30 active:scale-90 shadow-xl'>
                <Users size={24} className="md:w-8 md:h-8 text-indigo-400" /><span className='text-[7px] md:text-[8px] font-black'>{t.splitSwarm.toUpperCase()}</span>
                <div className='absolute -top-2 -right-2 bg-slate-950 border border-white/20 rounded-md px-1.5 py-0.5 text-[8px] font-black text-white'>C</div>
              </button>
              <button onClick={() => { 
                if (playerRef.current && playerRef.current.attackCooldown <= 0) { 
                  playerRef.current.isAttacking = true; 
                  playerRef.current.attackTimer = 300; 
                  playerRef.current.attackCooldown = 500; 
                  if (socketRef.current && currentRoom) {
                    socketRef.current.emit('attack', { roomId: currentRoom.id });
                  }
                } 
              }} className='w-20 h-20 md:w-24 md:h-24 rounded-full border-2 md:border-4 flex items-center justify-center transition-all bg-red-600/20 border-red-500/30 active:scale-90 shadow-xl shadow-red-500/10'>
                <Sword size={32} className="md:w-10 md:h-10 text-red-500" />
              </button>
              <button onMouseDown={() => { if (playerRef.current) playerRef.current.isDashing = true; setIsDashing(true); }} onMouseUp={() => { if (playerRef.current) playerRef.current.isDashing = false; setIsDashing(false); }} onTouchStart={() => { if (playerRef.current) playerRef.current.isDashing = true; setIsDashing(true); }} onTouchEnd={() => { if (playerRef.current) playerRef.current.isDashing = false; setIsDashing(false); }} className={`relative w-20 h-20 md:w-24 md:h-24 rounded-full border-2 md:border-4 flex items-center justify-center transition-all shadow-xl ${isDashing ? 'bg-yellow-500 border-yellow-300 scale-90' : 'bg-white/10 border-white/20'}`}>
                <Zap size={32} className={cn("md:w-10 md:h-10", isDashing ? 'text-white' : 'text-yellow-500')} />
                <div className='absolute -top-2 -right-2 bg-slate-950 border border-white/20 rounded-md px-1.5 py-0.5 text-[8px] font-black text-white'>SHIFT</div>
              </button>
            </div>
          </div>

          <div className='absolute top-4 right-4 md:top-6 md:right-6 w-32 md:w-40 bg-slate-900/50 backdrop-blur rounded-xl md:rounded-2xl border border-white/10 overflow-hidden z-[110]'>
            <div className='bg-white/10 px-2 py-1.5 md:px-4 md:py-2 flex items-center gap-1.5 md:gap-2'><Crown size={12} className='text-yellow-500 md:w-4 md:h-4' /><span className='text-[9px] md:text-xs font-bold tracking-wider uppercase'>{t.leaderboard}</span></div>
            <div className='p-2 md:p-3 flex flex-col gap-1 md:gap-2'>
              {(leaderboard || []).map((entry, i) => (
                <div key={i} className='flex justify-between items-center text-[10px] md:text-sm'>
                  <span className={`truncate flex-1 ${i === 0 ? 'text-yellow-400 font-bold' : 'text-slate-300'}`}>{i + 1}. {entry.name}</span>
                  <span className='font-mono text-slate-400 ml-1.5 md:ml-2'>{entry.score}</span>
                </div>
              ))}
            </div>
          </div>

          {showShop && (
            <div className='absolute inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 md:p-6 z-[120]' onClick={() => setShowShop(false)}>
              <div className='bg-slate-900 border-2 border-indigo-500 rounded-[1.5rem] md:rounded-[2.5rem] p-4 md:p-8 max-w-sm md:max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl scale-in-center custom-scrollbar' onClick={e => e.stopPropagation()}>
                <div className='flex items-center justify-between mb-4 md:mb-8'>
                  <div>
                    <h3 className='text-xl md:text-3xl font-black uppercase tracking-tighter'>{t.shop}</h3>
                    <p className='text-indigo-400 font-bold text-[8px] md:text-[10px] uppercase tracking-widest'>{t.strategyTip}</p>
                  </div>
                  <button onClick={() => setShowShop(false)} className='w-8 h-8 md:w-12 md:h-12 rounded-xl md:rounded-2xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all'>
                    <span className="text-sm md:text-xl font-black">✕</span>
                  </button>
                </div>

                <div className='grid grid-cols-1 gap-3 md:gap-4'>
                  <div className='space-y-2 md:space-y-3'>
                    <p className='text-[8px] md:text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] px-2'>{t.recruitment}</p>
                    <div className='grid grid-cols-1 sm:grid-cols-2 gap-2'>
                      {[1, 10, 50, 100].map(count => (
                        <button 
                          key={count}
                          onClick={() => { 
                            if (playerRef.current && playerRef.current.akce >= UNIT_PRICES.infantry * count) {
                              playerRef.current.akce -= UNIT_PRICES.infantry * count;
                              setPlayerAkce(playerRef.current.akce);
                              for(let i=0; i<count; i++) {
                                playerRef.current.units.push({ id: generateId(), pos: { ...playerRef.current.units[0].pos }, color: playerRef.current.color, type: 'infantry', hp: 100 });
                              }
                              setScore(playerRef.current.units.length);
                              createDust(playerRef.current.units[0].pos.x, playerRef.current.units[0].pos.y, playerRef.current.color);
                            } else {
                              showError(t.notEnoughAkce || "Not enough Akçe!");
                            }
                          }} 
                          className='w-full flex items-center justify-between bg-slate-800/50 hover:bg-indigo-600/20 p-2 md:p-3 rounded-xl md:rounded-2xl border border-white/5 transition-all group'
                        >
                          <div className='flex items-center gap-2 md:gap-3'>
                            <div className='w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 group-hover:scale-110 transition-transform'><Users size={16} className="md:w-5 md:h-5" /></div>
                            <div className='text-left'>
                              <div className='text-[10px] md:text-sm font-bold uppercase'>+{count}</div>
                              <div className='text-[6px] md:text-[8px] text-slate-500 font-bold uppercase'>{count === 1 ? t.recruitInfantry : t.warriors || "Warriors"}</div>
                            </div>
                          </div>
                          <div className='flex items-center gap-1 bg-slate-950 px-1.5 py-0.5 md:px-2 md:py-1 rounded-lg font-black text-amber-500 border border-amber-500/20 text-[10px] md:text-xs'>
                            {UNIT_PRICES.infantry * count} <span className='text-[5px] md:text-[7px]'>{getEmpireCurrency().toUpperCase()}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className='space-y-2 md:space-y-3'>
                    <p className='text-[8px] md:text-[10px] text-slate-500 font-black uppercase tracking-[0.2em] px-2'>{t.construction}</p>
                    <div className='grid grid-cols-1 gap-2'>
                      {/* NEW: Shovels in Shop */}
                      <button onClick={() => { 
                        if (playerRef.current && playerRef.current.akce >= 10) {
                          playerRef.current.akce -= 10;
                          playerRef.current.shovelUses = 10;
                          playerRef.current.equippedItem = 'shovel';
                          setActiveSlot(1); // Auto-select shovel slot
                          setPlayerAkce(playerRef.current.akce);
                          setShowShop(false);
                        }
                      }} className='w-full flex items-center justify-between bg-slate-800/50 hover:bg-yellow-600/20 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5 transition-all group'>
                        <div className='flex items-center gap-3 md:gap-4'>
                          <div className='w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-yellow-500/20 flex items-center justify-center group-hover:scale-110 transition-transform'>
                            <ShovelIcon className="w-8 h-8 md:w-10 md:h-10" />
                          </div>
                          <div className='text-left'><div className='text-xs md:text-base font-bold uppercase'>Купить Лопату</div><div className='text-[8px] md:text-[10px] text-slate-500 font-bold uppercase'>10 использований</div></div>
                        </div>
                        <div className='flex items-center gap-1.5 bg-slate-950 px-2 py-1 md:px-3 md:py-1.5 rounded-lg md:rounded-xl font-black text-amber-500 border border-amber-500/20 text-[10px] md:text-base'>10 <span className='text-[6px] md:text-[8px]'>AKÇE</span></div>
                      </button>
                      <button onClick={() => { 
                        if (playerRef.current && playerRef.current.akce >= 30) {
                          playerRef.current.akce -= 30;
                          playerRef.current.shovelUses = 30;
                          playerRef.current.equippedItem = 'super_shovel';
                          setActiveSlot(1); // Auto-select shovel slot
                          setPlayerAkce(playerRef.current.akce);
                          setShowShop(false);
                        }
                      }} className='w-full flex items-center justify-between bg-slate-800/50 hover:bg-yellow-600/20 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5 transition-all group'>
                        <div className='flex items-center gap-3 md:gap-4'>
                          <div className='w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-yellow-500/20 flex items-center justify-center group-hover:scale-110 transition-transform relative'>
                            <ShovelIcon isSuper={true} className="w-8 h-8 md:w-10 md:h-10" />
                            <span className="absolute text-[10px] top-1 left-1">✨</span>
                          </div>
                          <div className='text-left'><div className='text-xs md:text-base font-bold uppercase'>Супер Лопата</div><div className='text-[8px] md:text-[10px] text-slate-500 font-bold uppercase'>30 использований</div></div>
                        </div>
                        <div className='flex items-center gap-1.5 bg-slate-950 px-2 py-1 md:px-3 md:py-1.5 rounded-lg md:rounded-xl font-black text-amber-500 border border-amber-500/20 text-[10px] md:text-base'>30 <span className='text-[6px] md:text-[8px]'>AKÇE</span></div>
                      </button>

                      <button onClick={() => { 
                        setIsPlacingTower(true); 
                        setIsPlacingWall(false); 
                        setIsPlacingGate(false); 
                        setShowShop(false); 
                      }} className='w-full flex items-center justify-between bg-slate-800/50 hover:bg-emerald-600/20 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5 transition-all group'>
                        <div className='flex items-center gap-3 md:gap-4'>
                          <div className='w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-110 transition-transform'><Shield size={20} className="md:w-6 md:h-6" /></div>
                          <div className='text-left'><div className='text-xs md:text-base font-bold uppercase'>{t.buildTower}</div><div className='text-[8px] md:text-[10px] text-slate-500 font-bold uppercase'>{t.defensive}</div></div>
                        </div>
                        <div className='flex items-center gap-1.5 bg-slate-950 px-2 py-1 md:px-3 md:py-1.5 rounded-lg md:rounded-xl font-black text-amber-500 border border-amber-500/20 text-[10px] md:text-base'>{UNIT_PRICES.tower} <span className='text-[6px] md:text-[8px]'>AKÇE</span></div>
                      </button>
                      <button onClick={() => { 
                        setIsPlacingWall(true); 
                        setIsPlacingTower(false); 
                        setIsPlacingGate(false); 
                        setShowShop(false); 
                      }} className='w-full flex items-center justify-between bg-slate-800/50 hover:bg-emerald-600/20 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5 transition-all group'>
                        <div className='flex items-center gap-3 md:gap-4'>
                          <div className='w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-110 transition-transform'><Shield size={20} className="md:w-6 md:h-6" /></div>
                          <div className='text-left'><div className='text-xs md:text-base font-bold uppercase'>{t.buildWall}</div><div className='text-[8px] md:text-[10px] text-slate-500 font-bold uppercase'>{t.obstacle}</div></div>
                        </div>
                        <div className='flex items-center gap-1.5 bg-slate-950 px-2 py-1 md:px-3 md:py-1.5 rounded-lg md:rounded-xl font-black text-amber-500 border border-amber-500/20 text-[10px] md:text-base'>{UNIT_PRICES.wall} <span className='text-[6px] md:text-[8px]'>AKÇE</span></div>
                      </button>
                      <button onClick={() => { 
                        setIsPlacingGate(true); 
                        setIsPlacingWall(false); 
                        setIsPlacingTower(false); 
                        setShowShop(false); 
                      }} className='w-full flex items-center justify-between bg-slate-800/50 hover:bg-emerald-600/20 p-3 md:p-4 rounded-xl md:rounded-2xl border border-white/5 transition-all group'>
                        <div className='flex items-center gap-3 md:gap-4'>
                          <div className='w-10 h-10 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-400 group-hover:scale-110 transition-transform'><Shield size={20} className="md:w-6 md:h-6" /></div>
                          <div className='text-left'><div className='text-xs md:text-base font-bold uppercase'>{t.buildGate}</div><div className='text-[8px] md:text-[10px] text-slate-500 font-bold uppercase'>{t.passableBarrier}</div></div>
                        </div>
                        <div className='flex items-center gap-1.5 bg-slate-950 px-2 py-1 md:px-3 md:py-1.5 rounded-lg md:rounded-xl font-black text-amber-500 border border-amber-500/20 text-[10px] md:text-base'>{UNIT_PRICES.gate} <span className='text-[6px] md:text-[8px]'>AKÇE</span></div>
                      </button>
                    </div>
                  </div>

                  <div className='space-y-2 md:space-y-4'>
                    <p className='text-[8px] md:text-xs text-slate-500 font-black uppercase tracking-[0.2em] px-2'>{t.treasury}</p>
                    <div className='grid grid-cols-2 gap-2 md:gap-3 px-1'>
                      {[1, 5, 10, 50].map((count) => (
                        <button 
                          key={count} 
                          onClick={() => { if (playerRef.current) dismissUnits(playerRef.current, count); }} 
                          className='flex items-center justify-between bg-slate-800/50 hover:bg-red-600/20 p-2 md:p-4 rounded-xl md:rounded-2xl border border-white/5 transition-all group'
                        >
                          <div className='flex flex-col items-start'>
                            <div className='flex items-center gap-1 text-sm md:text-lg font-black text-red-400 group-hover:scale-105 transition-transform'>
                              <Users size={14} className="md:w-[18px] md:h-[18px]" />
                              -{count}
                            </div>
                            <span className='text-[6px] md:text-[10px] text-slate-500 font-bold uppercase'>{t.sellInfantry}</span>
                          </div>
                          <div className='text-slate-400 text-xs md:text-xl font-bold'>→</div>
                          <div className='flex flex-col items-end'>
                            <div className='text-sm md:text-lg font-black text-amber-500'>+{count * 5}</div>
                            <span className='text-[6px] md:text-[10px] text-amber-500/60 font-bold uppercase'>{getEmpireCurrency()}</span>
                          </div>
                        </button>
                      ))}
                      <button 
                        onClick={() => { if (playerRef.current) dismissUnits(playerRef.current, 'ALL'); }} 
                        className='col-span-2 flex items-center justify-between bg-red-600/10 hover:bg-red-600/20 p-3 md:p-4 rounded-xl md:rounded-2xl border border-red-500/20 transition-all group'
                      >
                        <div className='flex items-center gap-2 md:gap-3'>
                          <div className='w-8 h-8 md:w-12 md:h-12 rounded-lg md:rounded-xl bg-red-500/20 flex items-center justify-center text-red-500 group-hover:scale-110 transition-transform'>
                            <Users size={18} className="md:w-6 md:h-6" />
                          </div>
                          <div className='text-left'>
                            <div className='text-sm md:text-xl font-black text-red-500 uppercase'>{t.sell} {t.all}</div>
                            <div className='text-[8px] md:text-xs text-red-400/60 font-bold uppercase'>{t.sellInfantry}</div>
                          </div>
                        </div>
                        <div className='flex flex-col items-end'>
                          <div className='text-sm md:text-xl font-black text-amber-500'>MAX</div>
                          <span className='text-[8px] md:text-xs text-amber-500/60 font-bold uppercase'>{getEmpireCurrency()}</span>
                        </div>
                      </button>
                    </div>
                    <p className='text-[8px] md:text-[10px] text-slate-400 font-bold uppercase tracking-widest px-2 text-center leading-relaxed'>{t.treasuryDesc}</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSplitGarrisonId && (
            <div className='absolute inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-6 z-[60]' onClick={() => setActiveSplitGarrisonId(null)}>
                <div className='bg-slate-900 border-2 border-indigo-500 rounded-3xl p-8 max-w-sm w-full shadow-2xl scale-in-center' onClick={e => e.stopPropagation()}>
                    <h3 className='text-2xl font-black mb-2 text-center uppercase'>{t.squadSeparated}</h3>
                    <p className='text-slate-400 text-center mb-6 text-sm'>{t.assignObjective}</p>
                    <div className='grid grid-cols-1 gap-3'>
                        <button onClick={() => { executeSplit('HOLD'); }} className='flex items-center gap-4 bg-slate-800 hover:bg-emerald-600/20 p-4 rounded-2xl border border-white/5 transition-all'>
                            <div className='w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center text-2xl'>🛡️</div>
                            <div className='text-left'><div className='font-bold'>{t.hold}</div><div className='text-xs text-slate-400'>{t.defendTerrain}</div></div>
                        </button>
                        <button onClick={() => { executeSplit('HUNT'); }} className='flex items-center gap-4 bg-slate-800 hover:bg-red-600/20 p-4 rounded-2xl border border-white/5 transition-all'>
                            <div className='w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center text-2xl'>⚔️</div>
                            <div className='text-left'><div className='font-bold'>{t.hunt}</div><div className='text-xs text-slate-400'>{t.seekHostiles}</div></div>
                        </button>
                        <button onClick={() => { executeSplit('RECALL'); }} className='flex items-center gap-4 bg-slate-800 hover:bg-blue-600/20 p-4 rounded-2xl border border-white/5 transition-all'>
                            <div className='w-12 h-12 rounded-xl bg-blue-500/20 flex items-center justify-center text-2xl'>🏃</div>
                            <div className='text-left'><div className='font-bold'>{t.recall}</div><div className='text-xs text-slate-400'>{t.returnToSultan}</div></div>
                        </button>
                        <button onClick={() => { executeSplit('SEPARATE_ALL'); }} className='flex items-center gap-4 bg-indigo-600/20 hover:bg-indigo-600/40 p-4 rounded-2xl border border-indigo-500/30 transition-all'>
                            <div className='w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center text-2xl'>👥</div>
                            <div className='text-left'><div className='font-bold'>{t.separateAll}</div><div className='text-xs text-indigo-300'>{t.assignTask}</div></div>
                        </button>
                    </div>
                </div>
            </div>
          )}

          {showExitConfirm && (
            <div className='absolute inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-6 z-[300] animate-in fade-in duration-300' onClick={() => setShowExitConfirm(false)}>
              <div className='bg-slate-900 border border-white/10 rounded-[2rem] p-8 max-w-sm w-full shadow-2xl scale-in-center overflow-hidden relative' onClick={e => e.stopPropagation()}>
                <div className='absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 via-orange-500 to-red-500'></div>
                <div className='flex flex-col items-center text-center'>
                  <div className='w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-500 mb-6'>
                    <LogOut size={32} />
                  </div>
                  <h3 className='text-2xl font-black mb-3 text-white uppercase tracking-tighter leading-tight'>
                    {t.areYouSureExit}
                  </h3>
                  <p className='text-slate-400 mb-8 text-sm font-medium leading-relaxed'>
                    {t.exitWarning || 'Ваш текущий прогресс в этом сражении будет потерян.'}
                  </p>
                  <div className='grid grid-cols-1 gap-3 w-full'>
                    <button 
                      onClick={() => { leaveRoom(); setShowExitConfirm(false); }} 
                      className='w-full py-4 bg-red-600 hover:bg-red-500 text-white rounded-2xl font-black uppercase tracking-widest text-sm transition-all shadow-lg shadow-red-600/20 active:scale-95'
                    >
                      {t.confirmExit || 'Да, выйти'}
                    </button>
                    <button 
                      onClick={() => setShowExitConfirm(false)} 
                      className='w-full py-4 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white rounded-2xl font-black uppercase tracking-widest text-sm transition-all active:scale-95'
                    >
                      {t.cancel || 'Отмена'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
export default SwarmEngine;
