// 运行时冒烟验证（fake-indexeddb）：用 esbuild 即时打包后在 node 里跑
import assert from 'node:assert';
import 'fake-indexeddb/auto';

const { default: Dexie } = await import('dexie');
const { catalogDb } = await import('../src/db/catalogDb');
const { planDb } = await import('../src/db/planDb');
const { migrateV2ToSplit } = await import('../src/db/migrate');
const { useTargetStore } = await import('../src/stores/targetStore');
const { useSessionStore } = await import('../src/stores/sessionStore');
const { useNightStore } = await import('../src/stores/nightStore');
const { SCHEMA_VERSION } = await import('../src/db/catalogSchema');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓', name); pass++; };

/* ============ 场景 1：v2 旧库 → 拆分回填 + 归属 + 快照 ============ */
console.log('场景1：v2 旧数据按归属回填');
{
  const legacy = new Dexie('gbobsplan-db');
  legacy.version(2).stores({
    targets: 'id, name',
    sessions: 'id, nightId, targetId, telescopeId, startTime, status, backupNightId',
    telescopes: 'id, code, status',
    instruments: 'id, model',
    nights: 'id, date',
    meta: 'key',
  });
  await legacy.targets.bulkPut([
    { id: 'tg1', name: 'M31', catalog: 'NGC224', raHours: 0.7, decDeg: 41, magnitude: 3.4, type: '星系', filter: 'L', exposureSec: 120, totalMinutes: 90, priority: 'P1', minAltitude: 25 },
    { id: 'tg2', name: 'M42', minAltitude: 20, exposureSec: 60, totalMinutes: 60, filter: 'L' },
  ]);
  await legacy.nights.bulkPut([
    { id: 'n1', date: '2025-10-11', primary: true, backup: false, siteName: 'X', siteLat: 1, siteLng: 2, moonPhasePct: 10, moonrise: '1', moonset: '2', sunset: '3', sunrise: '4', cloudText: '晴', dutyOfficer: 'A' },
    { id: 'n2', date: '2025-10-12', primary: false, backup: true },
  ]);
  await legacy.telescopes.put({ id: 't1', code: 'T-01', status: '可用' });
  await legacy.instruments.put({ id: 'i1', model: 'Cam', telescopeCode: 'T-01' });
  await legacy.sessions.bulkPut([
    { id: 's1', nightId: 'n1', targetId: 'tg1', startTime: '20:00', endTime: '21:00', telescopeId: 't1', instrumentId: 'i1', filterSlot: 'L', plannedFrames: 10, status: '已完成', schemaVersion: 2 },
    { id: 's2', nightId: 'n1', targetId: 'tg1', startTime: '21:00', endTime: '22:00', telescopeId: 't1', instrumentId: 'i1', filterSlot: 'L', plannedFrames: 10, status: '待执行', schemaVersion: 2 },
    { id: 's3', nightId: 'n1', targetId: 'tg2', startTime: '22:00', endTime: '23:00', telescopeId: 't1', instrumentId: 'i1', filterSlot: 'L', plannedFrames: 10, status: '待执行', schemaVersion: 2 },
  ]);
  await legacy.close();

  const r = await migrateV2ToSplit();
  ok('迁移执行完成', r.migrated === true);

  const tg = await catalogDb.targets.get('tg1');
  ok('目标回填 owner=catalog', tg.owner === 'catalog');
  ok('目标回填 revision=1', tg.revision === 1);
  const sn2 = await planDb.sessions.get('s2');
  ok('排程段回填 owner=plan', sn2.owner === 'plan');
  ok('排程段快照按旧目标值固化(25°/120s/v1)', sn2.targetSnapshot.minAltitude === 25 && sn2.targetSnapshot.exposureSec === 120 && sn2.targetSnapshot.revision === 1);
  const night = await planDb.nights.get('n1');
  ok('观测夜回填 owner=plan', night.owner === 'plan');

  const existsAfter = await Dexie.exists('gbobsplan-db');
  ok('两侧回填成功后旧库已删除', existsAfter === false);

  // 再次执行：无旧库，标记已在，直接放行
  const r2 = await migrateV2ToSplit();
  ok('迁移幂等可重入', r2.migrated === true);
}

/* ============ 场景 2：阈值改动 → 未拍完段失效，已完成照旧 ============ */
console.log('场景2：目标阈值改动联动待重排');
{
  await useTargetStore.getState().hydrate();
  await useNightStore.getState().hydrate();
  await useSessionStore.getState().hydrate();

  const before = await planDb.sessions.get('s2');
  ok('前置：s2 待执行', before.status === '待执行');

  const result = await useTargetStore.getState().updateTarget('tg1', { minAltitude: 45 });
  ok('目标 revision 升到 2', result.target.revision === 2);
  ok('约束确实变化', result.constraintChanged === true);
  ok('1 个未拍完段被打入待重排', result.invalidated === 1);

  const s1 = await planDb.sessions.get('s1');
  const s2 = await planDb.sessions.get('s2');
  ok('已完成的 s1 照旧留住', s1.status === '已完成');
  ok('待执行的 s2 → 待重排', s2.status === '待重排');
  ok('s2 带失效原因', Boolean(s2.invalidReason));
  ok('s2 快照仍停留在 v1（不被目标侧篡改）', s2.targetSnapshot.revision === 1 && s2.targetSnapshot.minAltitude === 25);

  // 改名称 / 备注不动排程
  const r2 = await useTargetStore.getState().updateTarget('tg1', { name: 'M31-仙女' });
  ok('只改名不算约束变化', r2.constraintChanged === false && r2.invalidated === 0);
  const s2again = await planDb.sessions.get('s2');
  ok('改名不重复打失效', s2again.status === '待重排');

  // 改成相同值不升版本
  const r3 = await useTargetStore.getState().updateTarget('tg1', { minAltitude: 45 });
  ok('相同阈值不升版本', r3.target.revision === 2);
}

/* ============ 场景 3：待重排不占容量；排程员重排确认 ============ */
console.log('场景3：排程员重排待重排段');
{
  // 重排 s2：夜不变、时段不变，此刻容量校验时 s2 自己是待重排不占容量，t1 当夜只有 s1(已完成 60min)
  const res = await useSessionStore.getState().updateSession('s2', { status: '待执行', nightId: 'n1', startTime: '21:00', endTime: '22:00' });
  ok('容量放得下 → 回到待执行', res.session.status === '待执行' && res.overflowed === false);
  const s2 = await planDb.sessions.get('s2');
  ok('失效原因已清', s2.invalidReason === undefined);
  ok('重排后快照刷新到目标 v2/45°', s2.targetSnapshot.revision === 2 && s2.targetSnapshot.minAltitude === 45);
}

/* ============ 场景 4：超容量 → 排队顺延，不挤掉已确认段 ============ */
console.log('场景4：一夜同望远镜超容量自动顺延');
{
  const sessions = useSessionStore.getState().sessions;
  const used = sessions.filter((s) => s.nightId === 'n1' && s.telescopeId === 't1' && ['待执行', '进行中', '已完成', '因云取消'].includes(s.status)).length;
  ok('前置：n1/t1 现有已确认段 s1+s2+s3 共 3 段 180 分钟（s3 引用 tg2 未受影响）', used === 3);

  // 加一段 700 分钟：180+700=880 > 720 → 顺延到 n2（2025-10-12）
  const add = await useSessionStore.getState().addSession({
    nightId: 'n1', targetId: 'tg2', startTime: '18:00', endTime: '05:40',
    telescopeId: 't1', instrumentId: 'i1', filterSlot: 'L', plannedFrames: 1, status: '待执行',
  });
  ok('新段被标记超容量', add.overflowed === true);
  ok('新段状态排队顺延', add.session.status === '排队顺延');
  ok('新段挂到后续观测夜 n2', add.session.nightId === 'n2');
  ok('带超容量原因', add.session.invalidReason.includes('超出容量'));

  // 已确认段一根毫毛没动
  const s1 = await planDb.sessions.get('s1');
  const s2 = await planDb.sessions.get('s2');
  ok('已确认段 s1/s2 时段状态不变', s1.status === '已完成' && s2.status === '待执行' && s2.startTime === '21:00');
}

/* ============ 场景 5：归属保护 —— 对侧写不进来 ============ */
console.log('场景5：谁也改不到对方那份');
{
  const tg = await catalogDb.targets.get('tg1');
  // 用编排侧的 session 接口去碰目标（通过 assertOwner 防护的直接体现）：构造 owner 不匹配
  const { assertOwner } = await import('../src/types/ownership');
  assert.throws(() => assertOwner(tg, 'plan', '测试'), /无权修改/);
  assert.throws(() => assertOwner({ id: 'x' }, 'catalog', '测试'), /尚未回填/);
  ok('归属校验拦截对侧写入与未回填记录', true);

  // 目标库里物理上没有 sessions 表
  ok('目标库无 sessions 表', catalogDb.tables.some((t) => t.name === 'sessions') === false);
  ok('编排库无 targets 表', planDb.tables.some((t) => t.name === 'targets') === false);
}

/* ============ 场景 6：启动 reconcile 修复“目标已提交、联动失败”中间态 ============ */
console.log('场景6：启动核对补标失效段');
{
  // 人为制造中间态：把一个 v2 快照的待执行段直接写回编排库（模拟联动那步失败）
  await planDb.sessions.put({
    id: 's9', nightId: 'n2', targetId: 'tg1', startTime: '20:00', endTime: '21:00',
    telescopeId: 't1', instrumentId: 'i1', filterSlot: 'L', plannedFrames: 5, status: '待执行',
    targetSnapshot: { revision: 1, minAltitude: 25, exposureSec: 120, totalMinutes: 90, filter: 'L' },
    owner: 'plan', schemaVersion: SCHEMA_VERSION,
  });
  const { reconcileSessionSnapshots } = await import('../src/services/invalidation');
  const targets = await catalogDb.targets.toArray();
  const changed = await reconcileSessionSnapshots(targets.map((t) => ({ id: t.id, revision: t.revision })));
  ok('核对补标了落后快照段', changed >= 1);
  const s9 = await planDb.sessions.get('s9');
  ok('s9 被补标为待重排', s9.status === '待重排');
}

/* ============ 场景 7：排队顺延段不占目标夜容量；改时段超容量只让自己顺延 ============ */
console.log('场景7：顺延段容量语义');
{
  // 再往 n1/t1 加一段 700 分钟：仍超容量，也顺延到 n2。两段顺延段都挂 n2，不得互相挤掉
  const add2 = await useSessionStore.getState().addSession({
    nightId: 'n1', targetId: 'tg1', startTime: '18:00', endTime: '05:40',
    telescopeId: 't1', instrumentId: 'i1', filterSlot: 'L', plannedFrames: 1, status: '待执行',
  });
  ok('第二个超容量段同样顺延到 n2', add2.session.status === '排队顺延' && add2.session.nightId === 'n2');

  const { usedCapacityMinutes, checkCapacity } = await import('../src/utils/scheduling');
  await useSessionStore.getState().hydrate();
  const allSessions = useSessionStore.getState().sessions;
  // n2/t1 只有两段排队顺延 + s9(待重排)，已确认占用应为 0
  ok('顺延 / 待重排段不占目标夜容量', usedCapacityMinutes(allSessions, 'n2', 't1') === 0);

  // 排程员把 n1 上一段已确认待执行段（s3，60min）改时段为 700 分钟，n1/t1 已确认 180min：
  // s3 自身重排为 700 → 180-60+700=820>720，只有 s3 自己顺延，s1/s2 不动
  const moved = await useSessionStore.getState().updateSession('s3', { startTime: '18:00', endTime: '05:40' });
  ok('改时段超容量时只有该段自己顺延', moved.overflowed === true && moved.session.status === '排队顺延' && moved.session.nightId === 'n2');
  const s1 = await planDb.sessions.get('s1');
  const s2 = await planDb.sessions.get('s2');
  ok('同夜已确认段 s1/s2 未被挪动', s1.status === '已完成' && s2.status === '待执行' && s2.nightId === 'n1' && s2.startTime === '21:00');

  // checkCapacity 对“放得下”的判定
  const fit = checkCapacity(useSessionStore.getState().sessions.filter((s) => s.id !== 's1'), 'n1', 't1', '20:00', '21:00');
  ok('s1 让出后 60 分钟段可放回 n1/t1', fit.fits === true);
}

console.log(`\n全部通过：${pass} 项断言`);
process.exit(0);
