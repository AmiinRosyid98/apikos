// QA cross-module live HTTP flow validation. Run against backend on 4100 (demo tenant).
// node tests/qa_xflow.mjs
const BASE = process.env.KOS_TEST_BASE || 'http://localhost:4100/api/v1';
const PW = 'Password123!';
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push(`PASS  ${name} ${extra}`); }
  else { fail++; results.push(`FAIL  ${name} ${extra}`); }
}
const tokens = {};
async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) json = await res.json();
  else json = { _raw: Buffer.from(await res.arrayBuffer()) , _ct: ct, _len: res.headers.get('content-length'), _cd: res.headers.get('content-disposition') };
  return { status: res.status, json };
}
async function login(email) {
  if (tokens[email]) return tokens[email];
  const r = await req('POST', '/auth/login', { body: { email, password: PW } });
  if (r.status !== 200) throw new Error(`login ${email} failed ${r.status} ${JSON.stringify(r.json)}`);
  tokens[email] = r.json.data.accessToken;
  return tokens[email];
}

const E = { owner: 'owner@demo.kos', manager: 'manager@demo.kos', admin: 'admin@demo.kos', finance: 'finance@demo.kos' };

async function main() {
  const owner = await login(E.owner);
  const admin = await login(E.admin);
  const finance = await login(E.finance);
  const manager = await login(E.manager);

  // Discover demo property + rooms
  const props = await req('GET', '/properties', { token: owner });
  const prop = props.json.data.find(p => p.name === 'Kos Melati') || props.json.data[0];
  ok('discover demo property', !!prop, `id=${prop?.id} name=${prop?.name}`);
  const rooms = await req('GET', `/properties/${prop.id}/rooms`, { token: owner });
  const roomList = rooms.json.data;
  const roomA1 = roomList.find(r => r.roomNumber === 'A1'); // occupied (Budi)
  const emptyRooms = roomList.filter(r => r.status === 'empty');
  ok('discover rooms', roomList.length >= 4, `count=${roomList.length}`);

  // ---- FLOW 1: Meter reading -> invoice includes electricity line ----
  // Find Budi resident (active in A1)
  const residents = await req('GET', `/residents?property_id=${prop.id}`, { token: owner });
  const budi = residents.json.data.find(r => r.roomId === roomA1?.id) || residents.json.data[0];
  ok('find active resident', !!budi, `id=${budi?.id} name=${budi?.fullName}`);
  // Use a far-future period to avoid clashing with seed invoice (June 2026)
  const pm = 9, py = 2026;
  // record electricity meter reading on A1
  const meter = await req('POST', `/rooms/${roomA1.id}/meter-readings`, {
    token: owner,
    body: { type: 'electricity', currentReading: 100, periodMonth: pm, periodYear: py, photoKey: 'qa/meter-a1.jpg' },
  });
  ok('meter: create reading 200/201', meter.status === 200 || meter.status === 201, `status=${meter.status}`);
  const usage = meter.json?.data?.usage;
  const meterAmount = Number(meter.json?.data?.amount);
  ok('meter: usage & amount computed', usage != null && meterAmount > 0, `usage=${usage} amount=${meterAmount}`);
  // generate invoice for that period for Budi
  const gen = await req('POST', '/invoices/generate', {
    token: owner, body: { propertyId: prop.id, periodMonth: pm, periodYear: py, residentIds: [budi.id] },
  });
  ok('meter->invoice: generate', gen.status === 200 || gen.status === 201, `status=${gen.status} created=${gen.json?.data?.created}`);
  let inv = gen.json?.data?.invoices?.[0];
  if (!inv) {
    // maybe already existed; fetch
    const list = await req('GET', `/invoices?resident_id=${budi.id}&period_month=${pm}&period_year=${py}`, { token: owner });
    inv = list.json.data[0];
  }
  ok('meter->invoice: invoice exists', !!inv, `invId=${inv?.id}`);
  if (inv) {
    const detail = await req('GET', `/invoices/${inv.id}`, { token: owner });
    const items = detail.json.data.items || [];
    const elec = items.find(i => i.type === 'electricity');
    ok('meter->invoice: electricity line present', !!elec, `desc="${elec?.description}" amt=${elec?.amount}`);
    ok('meter->invoice: electricity amount matches reading', elec && Number(elec.amount) === meterAmount, `line=${elec?.amount} reading=${meterAmount}`);
    const total = Number(detail.json.data.totalAmount);
    const sumItems = items.reduce((s, i) => s + Number(i.amount), 0);
    ok('meter->invoice: total includes all items', Math.abs(total - (sumItems + Number(detail.json.data.lateFee || 0))) < 0.01, `total=${total} sumItems=${sumItems}`);
  }

  // ---- FLOW 2: Booking lifecycle ----
  // create on an empty room
  const bRoom = emptyRooms[0];
  ok('booking: have an empty room', !!bRoom, `room=${bRoom?.roomNumber}`);
  const create = await req('POST', '/bookings', {
    token: admin,
    body: { propertyId: prop.id, roomId: bRoom.id, prospectName: 'QA Prospect', prospectPhone: '08123456789', plannedCheckInDate: '2026-10-01', bookingFeeAmount: 100000, bookingFeeMethod: 'cash' },
  });
  ok('booking: create (admin) 201', create.status === 201 || create.status === 200, `status=${create.status}`);
  const bookingId = create.json?.data?.id || create.json?.data?.booking?.id;
  // room now booking?
  let r2 = await req('GET', `/rooms/${bRoom.id}`, { token: owner });
  ok('booking: room status -> booking', r2.json.data.status === 'booking', `status=${r2.json.data.status}`);
  // finance cannot create
  const cFin = await req('POST', '/bookings', { token: finance, body: { propertyId: prop.id, roomId: emptyRooms[1]?.id, prospectName: 'X', prospectPhone: '08', plannedCheckInDate: '2026-10-01', bookingFeeAmount: 1, bookingFeeMethod: 'cash' } });
  ok('booking: finance create -> 403', cFin.status === 403, `status=${cFin.status}`);
  // confirm (manager+)
  const confirm = await req('PATCH', `/bookings/${bookingId}/confirm`, { token: manager });
  ok('booking: confirm (manager) -> confirmed', confirm.status === 200 && confirm.json.data.status === 'confirmed' && confirm.json.data.feeStatus === 'paid', `status=${confirm.json?.data?.status} fee=${confirm.json?.data?.feeStatus}`);
  // admin cannot confirm/cancel
  // convert (admin+) -> resident + occupancy + room occupied
  const convert = await req('PATCH', `/bookings/${bookingId}/convert`, { token: admin, body: { generateFirstInvoice: false } });
  const convStatus = convert.json?.data?.booking?.status || convert.json?.data?.status;
  ok('booking: convert -> converted', convert.status === 200 && convStatus === 'converted', `status=${convert.status}/${convStatus}`);
  const newResidentId = convert.json?.data?.residentId || convert.json?.data?.convertedResidentId;
  ok('booking: convert returns residentId', !!newResidentId, `residentId=${newResidentId}`);
  r2 = await req('GET', `/rooms/${bRoom.id}`, { token: owner });
  ok('booking: room status -> occupied after convert', r2.json.data.status === 'occupied', `status=${r2.json.data.status}`);
  // convert again -> 409
  const convAgain = await req('PATCH', `/bookings/${bookingId}/convert`, { token: admin, body: {} });
  ok('booking: re-convert -> 409', convAgain.status === 409, `status=${convAgain.status}`);
  // cancel flow on a fresh booking — re-fetch empty rooms (room state mutated above)
  const rooms2 = await req('GET', `/properties/${prop.id}/rooms?status=empty`, { token: owner });
  const freshEmpty = rooms2.json.data.filter(r => r.status === 'empty');
  const bRoom2 = freshEmpty[0];
  if (bRoom2) {
    const c2 = await req('POST', '/bookings', { token: admin, body: { propertyId: prop.id, roomId: bRoom2.id, prospectName: 'QA Cancel', prospectPhone: '081200000', plannedCheckInDate: '2026-10-01', bookingFeeAmount: 50000, bookingFeeMethod: 'cash' } });
    const b2 = c2.json?.data?.id || c2.json?.data?.booking?.id;
    const cancel = await req('PATCH', `/bookings/${b2}/cancel`, { token: manager, body: { reason: 'qa' } });
    ok('booking: cancel -> cancelled', cancel.status === 200 && cancel.json.data.status === 'cancelled', `status=${cancel.json?.data?.status}`);
    const r3 = await req('GET', `/rooms/${bRoom2.id}`, { token: owner });
    ok('booking: room -> empty after cancel', r3.json.data.status === 'empty', `status=${r3.json.data.status}`);
    // admin cancel -> 403 (need a booking; create another)
    if (freshEmpty[1]) {
      const c3 = await req('POST', '/bookings', { token: admin, body: { propertyId: prop.id, roomId: freshEmpty[1].id, prospectName: 'QA RBAC', prospectPhone: '081200000', plannedCheckInDate: '2026-10-01', bookingFeeAmount: 1, bookingFeeMethod: 'cash' } });
      const b3 = c3.json?.data?.id || c3.json?.data?.booking?.id;
      const adminCancel = await req('PATCH', `/bookings/${b3}/cancel`, { token: admin, body: { reason: 'x' } });
      ok('booking: admin cancel -> 403', adminCancel.status === 403, `status=${adminCancel.status}`);
    }
  }

  // ---- FLOW 3: Deposit ----
  const dep = await req('POST', `/residents/${budi.id}/deposits`, { token: admin, body: { amount: 1000000, method: 'cash', receivedDate: '2026-06-01' } });
  ok('deposit: record -> held', (dep.status === 201 || dep.status === 200) && dep.json.data.status === 'held', `status=${dep.status}/${dep.json?.data?.status}`);
  const depId = dep.json?.data?.id;
  // over-allocation 422
  const over = await req('POST', `/residents/${budi.id}/deposits/${depId}/refund`, { token: manager, body: { refundedAmount: 800000, deductionAmount: 300000, refundedDate: '2026-06-10' } });
  ok('deposit: over-allocation -> 422', over.status === 422, `status=${over.status}`);
  // refund with deduction -> partially_refunded
  const refund = await req('POST', `/residents/${budi.id}/deposits/${depId}/refund`, { token: manager, body: { refundedAmount: 700000, deductionAmount: 300000, refundedDate: '2026-06-10' } });
  ok('deposit: refund with deduction -> partially_refunded', refund.status === 200 && refund.json.data.status === 'partially_refunded' && Number(refund.json.data.refundedAmount) === 700000 && Number(refund.json.data.deductionAmount) === 300000, `status=${refund.json?.data?.status} ref=${refund.json?.data?.refundedAmount} ded=${refund.json?.data?.deductionAmount}`);

  // ---- FLOW 4: Handover + PDF ----
  const ho = await req('POST', `/residents/${budi.id}/handovers`, { token: admin, body: { type: 'checkin', date: '2026-06-01', inventory: [{ item: 'Kasur', condition: 'good' }], photoKeys: ['qa/ho1.jpg'], notes: 'qa handover' } });
  ok('handover: create checkin', ho.status === 201 || ho.status === 200, `status=${ho.status}`);
  const hoId = ho.json?.data?.handover?.id || ho.json?.data?.id;
  const pdf = await req('GET', `/handovers/${hoId}/pdf`, { token: owner });
  const pdfBuf = pdf.json?._raw;
  const isPdf = pdfBuf && pdfBuf.length > 4 && pdfBuf.slice(0, 4).toString('latin1') === '%PDF';
  ok('handover: PDF valid (%PDF magic, len>0)', pdf.status === 200 && isPdf, `status=${pdf.status} ct=${pdf.json?._ct} len=${pdfBuf?.length}`);

  // ---- FLOW 5: Finance ----
  const summary = await req('GET', `/finance/summary?property_id=${prop.id}&month=6&year=2026`, { token: owner });
  const s = summary.json.data;
  ok('finance: summary outstanding == invoiced - collected', Math.abs(Number(s.outstanding) - (Number(s.invoiced) - Number(s.collected))) < 0.01, `inv=${s.invoiced} col=${s.collected} out=${s.outstanding}`);
  const pl = await req('GET', `/finance/pl?property_id=${prop.id}&year=2026`, { token: finance });
  ok('finance: P&L finance allowed', pl.status === 200, `status=${pl.status}`);
  const plData = pl.json?.data;
  ok('finance: P&L net == revenue - expenses', plData && Math.abs(Number(plData.netProfit) - (Number(plData.totalRevenue ?? plData.revenue) - Number(plData.totalExpense ?? plData.totalExpenses))) < 0.01, `net=${plData?.netProfit} rev=${plData?.totalRevenue ?? plData?.revenue} exp=${plData?.totalExpense ?? plData?.totalExpenses}`);
  const plAdmin = await req('GET', `/finance/pl?property_id=${prop.id}&year=2026`, { token: admin });
  ok('finance: P&L admin -> 403', plAdmin.status === 403, `status=${plAdmin.status}`);
  const recon = await req('GET', `/finance/reconciliation?property_id=${prop.id}&month=6&year=2026`, { token: owner });
  ok('finance: reconciliation diff == invoiced - collected', Math.abs(Number(recon.json.data.diff) - (Number(recon.json.data.invoiced ?? recon.json.data.totalInvoiced) - Number(recon.json.data.collected ?? recon.json.data.totalCollected))) < 0.01, `diff=${recon.json?.data?.diff}`);

  // ---- FLOW 6: Reports + xlsx export ----
  for (const t of ['invoices', 'residents', 'occupancy', 'revenue', 'room-types']) {
    const rep = await req('GET', `/reports/${t}${t === 'occupancy' ? '?months=6' : ''}`, { token: admin });
    ok(`reports: ${t} JSON 200`, rep.status === 200, `status=${rep.status}`);
  }
  const exp = await req('GET', '/reports/invoices/export.xlsx', { token: owner });
  const xbuf = exp.json?._raw;
  const isXlsx = xbuf && xbuf.length > 4 && xbuf[0] === 0x50 && xbuf[1] === 0x4b && xbuf[2] === 0x03 && xbuf[3] === 0x04;
  ok('reports: xlsx export valid (PK magic)', exp.status === 200 && isXlsx, `status=${exp.status} ct=${exp.json?._ct} len=${xbuf?.length}`);
  const expAdmin = await req('GET', '/reports/invoices/export.xlsx', { token: admin });
  ok('reports: export admin -> 403', expAdmin.status === 403, `status=${expAdmin.status}`);

  // ---- FLOW 7: Tenant isolation spot-check on new modules ----
  // Register a fresh tenant B (owner) and try to read tenant A's resources by id -> expect 404
  const ts = Date.now();
  const reg = await req('POST', '/auth/register', { body: { businessName: `QA-XFLOW-${ts}`, fullName: 'B Owner', email: `qa-xflow-${ts}@demo.kos`, password: PW } });
  ok('isolation: register tenant B', reg.status === 201 || reg.status === 200, `status=${reg.status}`);
  const tbTok = reg.json?.data?.accessToken;
  if (tbTok && bookingId) {
    const xBook = await req('GET', `/bookings/${bookingId}`, { token: tbTok });
    ok('isolation: B reads A booking -> 404', xBook.status === 404, `status=${xBook.status}`);
  }
  if (tbTok && hoId) {
    const xHo = await req('GET', `/handovers/${hoId}`, { token: tbTok });
    ok('isolation: B reads A handover -> 404', xHo.status === 404, `status=${xHo.status}`);
  }
  if (tbTok && inv) {
    const xInv = await req('GET', `/invoices/${inv.id}`, { token: tbTok });
    ok('isolation: B reads A invoice -> 404', xInv.status === 404, `status=${xInv.status}`);
  }

  // ---- FLOW 8: Plan gating on a Basic tenant ----
  // New tenant defaults to basic plan
  const basicTok = tbTok;
  const basicProps = await req('GET', '/properties', { token: basicTok });
  // create a property + room so we have a room id for meter
  const cp = await req('POST', '/properties', { token: basicTok, body: { name: 'Basic Prop', type: 'putra', address: 'x', city: 'Jakarta', province: 'DKI' } });
  const bpId = cp.json?.data?.id;
  let bRoomId = null;
  if (bpId) {
    const cr = await req('POST', `/properties/${bpId}/rooms`, { token: basicTok, body: { roomNumber: 'X1', roomType: 'standard', basePrice: 500000 } });
    bRoomId = cr.json?.data?.id;
  }
  if (bRoomId) {
    const m = await req('POST', `/rooms/${bRoomId}/meter-readings`, { token: basicTok, body: { type: 'electricity', currentReading: 10, periodMonth: 6, periodYear: 2026, photoKey: 'x.jpg' } });
    ok('plan-gate: Basic meter create -> 403', m.status === 403, `status=${m.status}`);
  }
  // deposit needs a resident; we'll just check the report export + pl gate which don't need extra entities
  const bExp = await req('GET', '/reports/invoices/export.xlsx', { token: basicTok });
  ok('plan-gate: Basic reports export -> 403', bExp.status === 403, `status=${bExp.status}`);
  const bPl = await req('GET', '/finance/pl?year=2026', { token: basicTok });
  ok('plan-gate: Basic finance P&L -> 403', bPl.status === 403, `status=${bPl.status}`);
  // basic JSON report view still allowed
  const bView = await req('GET', '/reports/invoices', { token: basicTok });
  ok('plan-gate: Basic reports JSON view -> 200', bView.status === 200, `status=${bView.status}`);

  console.log('\n' + results.join('\n'));
  console.log(`\n==== XFLOW RESULT: ${pass} pass / ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('XFLOW ERROR', e); process.exit(2); });
