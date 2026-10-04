import { create } from 'zustand';
import { planDb } from '../db/planDb';
import { OWNER_PLAN, assertOwner, type FieldOfView, type Instrument, type Telescope, type TelescopeStatus, type TerminalType } from '../types';
import { uid } from '../utils/id';

export interface TelescopeInput {
  code: string;
  apertureMm: number;
  focalLengthMm: number;
  mount: string;
  terminals: TerminalType[];
  maxPayloadKg: number;
  status: TelescopeStatus;
}

export interface InstrumentInput {
  model: string;
  terminalType: TerminalType;
  pixelSizeUm: number;
  sensorWidthMm: number;
  sensorHeightMm: number;
  readNoiseE: number;
  telescopeCode: string;
}

interface EquipmentState {
  telescopes: Telescope[];
  instruments: Instrument[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTelescope: (input: TelescopeInput) => Promise<Telescope>;
  updateTelescope: (id: string, patch: Partial<TelescopeInput>) => Promise<void>;
  removeTelescope: (id: string) => Promise<void>;
  addInstrument: (input: InstrumentInput) => Promise<Instrument>;
  updateInstrument: (id: string, patch: Partial<InstrumentInput>) => Promise<void>;
  removeInstrument: (id: string) => Promise<void>;
  /** 按靶面与焦距换算视场角 */
  fieldOfView: (telescopeId: string, instrumentId: string) => FieldOfView;
}

const RAD = Math.PI / 180;

/** 望远镜与终端（值班排程员）：只写 planDb；目标库碰不到设备数据 */
export const useEquipmentStore = create<EquipmentState>()((set, get) => ({
  telescopes: [],
  instruments: [],
  hydrated: false,

  hydrate: async () => {
    const [telescopes, instruments] = await Promise.all([planDb.telescopes.orderBy('code').toArray(), planDb.instruments.toArray()]);
    set({ telescopes, instruments, hydrated: true });
  },

  addTelescope: async (input) => {
    const telescope: Telescope = {
      id: uid('tel'),
      code: input.code.trim(),
      apertureMm: Number(input.apertureMm) || 0,
      focalLengthMm: Number(input.focalLengthMm) || 0,
      mount: input.mount.trim(),
      terminals: input.terminals.length ? input.terminals : ['CMOS 相机'],
      maxPayloadKg: Number(input.maxPayloadKg) || 0,
      status: input.status,
      owner: OWNER_PLAN,
    };
    await planDb.transaction('rw', planDb.telescopes, async () => {
      await planDb.telescopes.put(telescope);
    });
    set({ telescopes: [...get().telescopes, telescope].sort((a, b) => a.code.localeCompare(b.code)) });
    return telescope;
  },

  updateTelescope: async (id, patch) => {
    const current = get().telescopes.find((telescope) => telescope.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '更新望远镜');
    const next: Telescope = { ...current, ...patch, owner: OWNER_PLAN };
    await planDb.transaction('rw', planDb.telescopes, async () => {
      await planDb.telescopes.put(next);
    });
    set({ telescopes: get().telescopes.map((telescope) => (telescope.id === id ? next : telescope)) });
  },

  removeTelescope: async (id) => {
    const current = get().telescopes.find((telescope) => telescope.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '删除望远镜');
    await planDb.transaction('rw', planDb.telescopes, async () => {
      await planDb.telescopes.delete(id);
    });
    set({ telescopes: get().telescopes.filter((telescope) => telescope.id !== id) });
  },

  addInstrument: async (input) => {
    const instrument: Instrument = {
      id: uid('ins'),
      model: input.model.trim(),
      terminalType: input.terminalType,
      pixelSizeUm: Number(input.pixelSizeUm) || 0,
      sensorWidthMm: Number(input.sensorWidthMm) || 0,
      sensorHeightMm: Number(input.sensorHeightMm) || 0,
      readNoiseE: Number(input.readNoiseE) || 0,
      telescopeCode: input.telescopeCode,
      owner: OWNER_PLAN,
    };
    await planDb.transaction('rw', planDb.instruments, async () => {
      await planDb.instruments.put(instrument);
    });
    set({ instruments: [...get().instruments, instrument] });
    return instrument;
  },

  updateInstrument: async (id, patch) => {
    const current = get().instruments.find((instrument) => instrument.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '更新终端');
    const next: Instrument = { ...current, ...patch, owner: OWNER_PLAN };
    await planDb.transaction('rw', planDb.instruments, async () => {
      await planDb.instruments.put(next);
    });
    set({ instruments: get().instruments.map((instrument) => (instrument.id === id ? next : instrument)) });
  },

  removeInstrument: async (id) => {
    const current = get().instruments.find((instrument) => instrument.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '删除终端');
    await planDb.transaction('rw', planDb.instruments, async () => {
      await planDb.instruments.delete(id);
    });
    set({ instruments: get().instruments.filter((instrument) => instrument.id !== id) });
  },

  fieldOfView: (telescopeId, instrumentId) => {
    const telescope = get().telescopes.find((item) => item.id === telescopeId);
    const instrument = get().instruments.find((item) => item.id === instrumentId);
    if (!telescope || !instrument || telescope.focalLengthMm <= 0) {
      return { widthDeg: 0, heightDeg: 0, arcsecPerPixel: 0, text: '设备信息不完整，无法换算视场角' };
    }
    const widthDeg = (2 * Math.atan(instrument.sensorWidthMm / (2 * telescope.focalLengthMm))) / RAD;
    const heightDeg = (2 * Math.atan(instrument.sensorHeightMm / (2 * telescope.focalLengthMm))) / RAD;
    const arcsecPerPixel = (instrument.pixelSizeUm / telescope.focalLengthMm) * 206.265;
    return {
      widthDeg: Number(widthDeg.toFixed(2)),
      heightDeg: Number(heightDeg.toFixed(2)),
      arcsecPerPixel: Number(arcsecPerPixel.toFixed(2)),
      text: `${widthDeg.toFixed(2)}° × ${heightDeg.toFixed(2)}°（${arcsecPerPixel.toFixed(2)}″/px）`,
    };
  },
}));
