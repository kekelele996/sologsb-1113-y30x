import { create } from 'zustand';
import { planDb } from '../db/planDb';
import { OWNER_PLAN, assertOwner, type ObsNight } from '../types';
import { uid } from '../utils/id';

export interface NightInput {
  date: string;
  siteName: string;
  siteLat: number;
  siteLng: number;
  moonPhasePct: number;
  moonrise: string;
  moonset: string;
  sunset: string;
  sunrise: string;
  cloudText: string;
  primary: boolean;
  backup: boolean;
  dutyOfficer: string;
  remark?: string;
}

interface NightState {
  nights: ObsNight[];
  currentNightId: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setCurrentNight: (id: string) => void;
  addNight: (input: NightInput) => Promise<ObsNight>;
  updateNight: (id: string, patch: Partial<NightInput>) => Promise<void>;
  removeNight: (id: string) => Promise<void>;
}

/** 观测夜（值班排程员）：只写 planDb，与目标库互不连坐 */
export const useNightStore = create<NightState>()((set, get) => ({
  nights: [],
  currentNightId: '',
  hydrated: false,

  hydrate: async () => {
    const nights = await planDb.nights.orderBy('date').toArray();
    const current = get().currentNightId || nights.find((night) => night.primary)?.id || nights[0]?.id || '';
    set({ nights, currentNightId: current, hydrated: true });
  },

  setCurrentNight: (id) => set({ currentNightId: id }),

  addNight: async (input) => {
    const night: ObsNight = {
      id: uid('night'),
      date: input.date,
      siteName: input.siteName.trim(),
      siteLat: Number(input.siteLat) || 0,
      siteLng: Number(input.siteLng) || 0,
      moonPhasePct: Number(input.moonPhasePct) || 0,
      moonrise: input.moonrise,
      moonset: input.moonset,
      sunset: input.sunset,
      sunrise: input.sunrise,
      cloudText: input.cloudText,
      primary: input.primary,
      backup: input.backup,
      dutyOfficer: input.dutyOfficer.trim(),
      owner: OWNER_PLAN,
      remark: input.remark?.trim() || undefined,
    };
    await planDb.transaction('rw', planDb.nights, async () => {
      await planDb.nights.put(night);
    });
    set({ nights: [...get().nights, night].sort((a, b) => a.date.localeCompare(b.date)) });
    return night;
  },

  updateNight: async (id, patch) => {
    const current = get().nights.find((night) => night.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '更新观测夜');
    const next: ObsNight = { ...current, ...patch, owner: OWNER_PLAN };
    await planDb.transaction('rw', planDb.nights, async () => {
      await planDb.nights.put(next);
    });
    set({ nights: get().nights.map((night) => (night.id === id ? next : night)) });
  },

  removeNight: async (id) => {
    const current = get().nights.find((night) => night.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '删除观测夜');
    await planDb.transaction('rw', planDb.nights, async () => {
      await planDb.nights.delete(id);
    });
    set({ nights: get().nights.filter((night) => night.id !== id) });
  },
}));
